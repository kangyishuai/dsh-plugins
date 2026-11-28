// @ts-check
// 操作编排层：不依赖 typert，可在单元测试里用假 ctx 跑（真实宿主交互全部经 capability.js 探测）。
import { readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delayMs } from "node:timers/promises";
import { createAudit } from "./audit.js";
import { describeCapabilities, probeCapabilities } from "./capability.js";
import {
  beginOperation,
  finishOperation,
  listPending,
  listUnreadable,
  updateOperation,
} from "./journal.js";
import { directorySize, locateSession } from "./locate.js";
import { auditPath, requireSessionId, sessionsRoot, trashRoot } from "./paths.js";
import { buildPlan, digestOfWorkspace, planExecutable, summarizePlan } from "./plan.js";
import { readPreferences, writePreferences } from "./preferences.js";
import { listReceipts, writeReceipt } from "./receipts.js";
import { createRecovery } from "./recovery.js";
import { buildRefs, removeAllRefs, restoreAllRefs, snapshotAllRefs } from "./refs.js";
import { describeRestoreSummary, restoreSummary, verifyRestored } from "./restore.js";
import { listEntries, moveIntoTrash, purgeEntry, readEntry, restoreEntry } from "./trash.js";
import { readWorkspaceState } from "./workspace-state.js";

const nodeRequire = createRequire(import.meta.url);
const pkg = nodeRequire("../package.json");

/** 等宿主把 flush / 取消落盘写完再动文件。 */
const SETTLE_MS = 200;
/** 移走之后复查原路径的时间点；活句柄迟到写入会在这个窗口里重建目录。 */
const REVIVE_CHECK_MS = 1500;
/**
 * 单次批量 RPC 的条目上限。界面按 BATCH_CHUNK 分批调用，这里只是防御性硬上限：
 * 0.4.x 的上限是 50，用户回收站 80 条时「全选 → 彻底删除」会被整单拒绝，
 * 表现成「点了没反应」——所以上限要远大于一次常见的批量规模。
 */
const MAX_BATCH_IDS = 200;
/** 客户端每次批量请求的条数，同时也是这里建议的单批规模。 */
export const BATCH_CHUNK = 20;

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function failure(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

/**
 * 把 host 的活动条目归一成 { kind, count, labels, ids }。
 * @param {unknown[]} raw
 * @returns {{ kind: string, count: number, labels: string[], ids: string[] }[]}
 */
export function normalizeActivity(raw) {
  /** @type {Map<string, { kind: string, count: number, labels: string[], ids: string[] }>} */
  const groups = new Map();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const kind = String(/** @type {any} */ (entry)?.kind ?? "other");
    const items = Array.isArray(/** @type {any} */ (entry)?.items)
      ? /** @type {any} */ (entry).items
      : [];
    const group = groups.get(kind) ?? { kind, count: 0, labels: [], ids: [] };
    for (const item of items) {
      group.count += 1;
      const label =
        typeof item?.label === "string" && item.label.length > 0
          ? item.label
          : String(item?.id ?? "");
      if (label) group.labels.push(label);
      if (typeof item?.id === "string") group.ids.push(item.id);
    }
    groups.set(kind, group);
  }
  return [...groups.values()].filter((group) => group.count > 0);
}

/**
 * @param {{ ctx: any, dataRoot: string, logger: any }} options
 */
export function createOperations({ ctx, dataRoot, logger }) {
  /**
   * 能力探测**不能一次性固化**（USIM-U3-02 的根因）：桌面组合里 `workspaceRegistry`
   * 与 `agents` 比 `sessionPersistence` 晚挂载，插件启动对账在后者可用时就跑，
   * 探到的 caps 里 workspace 是 undefined —— 之后每次删除都跳过归档闸门/停止/工作区
   * 记账，每次恢复都把 `workspace-archive` 报成「unarchiveSession unavailable」。
   *
   * 所以 caps 与引用适配器都是**可刷新**的：每次进入操作前重探一次（只是几次属性读取），
   * 服务集合或门禁结果一变就**原地**重建 refs（原地重建让 createRecovery 早先拿到的
   * 数组引用也跟着更新，不需要把 refs 传遍每一层）。
   *
   * 原地重建的前提：`buildRefs()` 的条目**数量与顺序必须稳定**（同一次宿主组合下）。
   * 若以后新增按能力条件增删引用的适配器，就不能再用 length=0/push，要改成 getRefs()。
   */
  let caps = probeCapabilities(ctx);
  const refs = buildRefs(caps, logger, { dataRoot });

  /**
   * 影响引用适配器行为的探针结果。服务换了身份或门禁结论翻转都要重建适配器。
   * @param {import("./capability.js").Capabilities} value
   * @returns {unknown[]}
   */
  function hostSignature(value) {
    return [
      value.services.persistence,
      value.services.sessions,
      value.services.workspace,
      value.services.storageDomain,
      value.services.agents,
      value.checks["workspace.archive"],
      value.checks["workspace.unarchive"],
      value.checks["workspace.pin"],
      value.checks["workspace.unpin"],
      value.checks["workspace.list"],
      value.checks["storage.domain"],
      value.checks["sessions.detach"],
      value.checks["agents.detach"],
      value.checks["event.session-stop"],
    ];
  }

  /**
   * 重探宿主能力；有变化就重建引用适配器（原地）。返回最新的 caps。
   * @returns {import("./capability.js").Capabilities}
   */
  function refreshHost() {
    const next = probeCapabilities(ctx);
    const before = hostSignature(caps);
    const after = hostSignature(next);
    let changed = before.length !== after.length;
    for (let index = 0; !changed && index < before.length; index += 1) {
      if (before[index] !== after[index]) changed = true;
    }
    caps = next;
    if (changed) {
      const rebuilt = buildRefs(caps, logger, { dataRoot });
      refs.length = 0;
      refs.push(...rebuilt);
    }
    return caps;
  }

  const audit = createAudit(dataRoot);
  /** 当前进程里正在操作中的会话，防止双击/并发把同一个会话删两遍。 */
  const inFlight = new Set();
  /** 上一次启动对账的结论（内存里一份，磁盘上另有审计）。 @type {any} */
  let lastRecovery = null;
  /** @type {Promise<any> | null} */
  let recoveryInFlight = null;

  /**
   * 写审计。失败只降级成 logger 告警，绝不静默——但也不让审计故障阻断删除。
   * @param {any} entry
   */
  async function note(entry) {
    const result = await audit.append(entry);
    if (!result.ok) logger.warn(`session-delete: audit append failed: ${result.error}`);
    return result;
  }

  const recovery = createRecovery({
    dataRoot,
    refs,
    logger,
    audit,
    reconcile: (/** @type {string} */ sessionId, /** @type {any} */ options) =>
      reconcile(sessionId, options),
  });

  /**
   * 收集一份完整事实并生成 Plan。
   * @param {unknown} sessionIdRaw
   */
  /**
   * @param {unknown} sessionIdRaw
   * @param {{ all?: unknown[] }} [options] all = 预加载的 persistence.list()（工作区批量复用）
   */
  async function makePlan(sessionIdRaw, options = {}) {
    refreshHost();
    const sessionId = requireSessionId(sessionIdRaw);
    /** @type {string[]} */
    const notes = [];

    let stored;
    try {
      stored = await caps.services.persistence?.stat?.(sessionId);
    } catch (error) {
      notes.push(`stat failed: ${messageOf(error)}`);
    }
    const liveEntry = caps.services.sessions?.get?.(sessionId);
    if (!stored && !liveEntry) {
      throw failure("session/not-found", `no session named ${sessionId}`, { sessionId });
    }
    const header = stored?.header ?? liveEntry?.header ?? null;

    /** @type {unknown[]} */
    let rawActivity = [];
    if (typeof ctx.waterfall === "function") {
      try {
        rawActivity = await ctx.waterfall("workspace/session-activity", { sessionId }, () => []);
      } catch (error) {
        notes.push(`activity unavailable: ${messageOf(error)}`);
      }
    }
    const activity = normalizeActivity(rawActivity);

    // 子会话 = live 活动里的 subagent + 持久层 header.parentSession 血缘（任意深度）。
    // 后者需要 persistence.list()：对当前格式是 O(1) 级别，对历史格式可能按会话数扫描，
    // 因此只在真的删除/预览时调用，不参与面板等批量路径。
    /** @type {Map<string, { id: string, title: string | null }>} */
    const childMap = new Map();
    const subagents = activity.find((group) => group.kind === "subagent");
    (subagents?.ids ?? []).forEach((id, index) => {
      childMap.set(id, { id, title: subagents?.labels[index] ?? null });
    });
    if (caps.checks["persistence.list"] && caps.services.persistence?.list) {
      try {
        // 工作区批量会把同一个列表复用给每个会话，否则 N 个会话要拉 N 次全量列表。
        const all = options.all ?? (await caps.services.persistence.list()) ?? [];
        /** @type {Map<string, { id: string, title: string | null }[]>} */
        const byParent = new Map();
        for (const entry of all) {
          const id = String(entry?.id ?? entry?.header?.id ?? "");
          const parent = entry?.header?.parentSession;
          if (!id || typeof parent !== "string" || parent.length === 0) continue;
          const list = byParent.get(parent) ?? [];
          list.push({
            id,
            title: typeof entry?.header?.title === "string" ? entry.header.title : null,
          });
          byParent.set(parent, list);
        }
        const queue = [sessionId];
        const seen = new Set([sessionId]);
        while (queue.length > 0) {
          const current = /** @type {string} */ (queue.shift());
          for (const child of byParent.get(current) ?? []) {
            if (seen.has(child.id)) continue;
            seen.add(child.id);
            childMap.set(child.id, child);
            queue.push(child.id);
          }
        }
      } catch (error) {
        notes.push(`lineage unavailable: ${messageOf(error)}`);
      }
    }
    childMap.delete(sessionId);
    const children = [...childMap.values()];

    const located = await locateSession({
      dataRoot,
      sessionId,
      header,
      persistence: caps.services.persistence,
    });
    const location = located.location;
    const ambiguous = located.ambiguous;

    let sizeBytes = typeof stored?.sizeBytes === "number" ? stored.sizeBytes : null;
    if (sizeBytes === null && location) {
      sizeBytes = await directorySize(location.path).catch(() => null);
    }

    /** @type {{ code: string, message: string }[]} */
    const blockers = [];
    if (caps.tier === "unknown") {
      blockers.push({
        code: "session-delete/unsupported-host",
        message: "当前 DSH 版本缺少本插件依赖的核心接口，删除功能已禁用（只读模式）。",
      });
    }
    if (!location) {
      blockers.push(
        ambiguous.length > 1
          ? {
              code: "session-delete/ambiguous-location",
              message: `同一会话在 ${ambiguous.length} 个项目目录下都有副本，已拒绝操作。`,
            }
          : {
              code: "session-delete/location-unknown",
              message: "找不到这个会话在磁盘上的位置（可能宿主换了目录布局）。",
            },
      );
    }
    if (liveEntry && !caps.checks["event.session-stop"]) {
      blockers.push({
        code: "session-delete/live-unsupported",
        message: "会话正在运行，但当前宿主不支持安全停止，已拒绝删除。",
      });
    }

    const plan = buildPlan({
      sessionId,
      title: typeof header?.title === "string" ? header.title : null,
      cwd: typeof header?.cwd === "string" ? header.cwd : null,
      sizeBytes,
      live: Boolean(liveEntry),
      activity: activity.map(({ kind, count, labels }) => ({ kind, count, labels })),
      children,
      location,
      trashPath: null,
      removes: refs.map((ref) => ({ id: ref.id, label: ref.label, tier: ref.tier })),
      blockers,
    });
    return { plan, stored, header, location, refs, notes };
  }

  /**
   * 移走之后复查一次原路径；目录若被迟到的写入重建，就**真的**再移一次（AUD-SD-07）。
   * 只查一次、不循环：活句柄若持续写盘，由「未完成的操作」与体检暴露，而不是互相对抗。
   * @param {import("./plan.js").Plan} plan
   * @param {string} originalPath
   * @param {string} entryId 本次生成的回收站条目；它被 restore/purge 后守卫必须放手（B2）。
   */
  function scheduleReviveCheck(plan, originalPath, entryId) {
    const timer = setTimeout(async () => {
      try {
        await recovery.reviveGuard({
          sessionId: plan.sessionId,
          originalPath,
          entryId,
          meta: { title: plan.title, cwd: plan.cwd },
        });
      } catch (error) {
        logger.warn(`session-delete: revive check failed: ${messageOf(error)}`);
      }
    }, REVIVE_CHECK_MS);
    /** @type {any} */ (timer).unref?.();
  }

  /**
   * @param {string} sessionIdRaw
   * @param {{ digest?: string, title?: string | null, operator?: string, cascade?: boolean, child?: boolean,
   *   all?: unknown[] }} request all = 预加载的 persistence.list()（工作区批量复用）
   */
  async function trash(sessionIdRaw, request = {}) {
    refreshHost();
    const operator = request.operator ?? "ui";
    /** @type {Awaited<ReturnType<typeof makePlan>>} */
    let loaded;
    try {
      loaded = await makePlan(sessionIdRaw, { all: request.all });
    } catch (error) {
      // AUD-SD-04：plan 阶段的拒绝（not-found / invalid-id）同样是拒绝，必须进审计，
      // 否则「一次拒绝都没有记录过」的取证缺口会一直在。
      const code = /** @type {any} */ (error)?.code;
      if (code === "session/not-found" || code === "session-delete/invalid-id") {
        await note({ action: "trash", result: "refused", operator, detail: `plan:${code}` });
      }
      throw error;
    }
    const { plan, location, header } = loaded;
    if (request.digest && request.digest !== plan.digest) {
      await note({
        action: "trash",
        result: "refused",
        sessionId: plan.sessionId,
        operator,
        detail: "stale-plan：会话状态在确认期间发生变化",
      });
      throw failure(
        "session-delete/stale-plan",
        "会话状态在确认期间发生了变化，请重新查看影响面。",
        {
          expected: plan.digest,
          actual: request.digest,
        },
      );
    }
    if (!planExecutable(plan)) {
      await note({
        action: "trash",
        result: "refused",
        sessionId: plan.sessionId,
        operator,
        detail: plan.blockers.map((b) => b.code).join(","),
      });
      throw failure("session-delete/blocked", plan.blockers[0].message, {
        blockers: plan.blockers,
        plan,
      });
    }
    if (!location) throw failure("session-delete/location-unknown", "没有可移动的会话目录");

    /** @type {{ id: string, ok: boolean, entryId?: string, error?: string }[]} */
    const cascaded = [];
    if (request.cascade === true && request.child !== true) {
      for (const child of plan.children) {
        try {
          const result = await trash(child.id, { operator, child: true });
          cascaded.push({ id: child.id, ok: true, entryId: result.entryId });
        } catch (error) {
          cascaded.push({ id: child.id, ok: false, error: messageOf(error) });
        }
      }
    }

    if (inFlight.has(plan.sessionId)) {
      throw failure("session-delete/busy", "这个会话正在被另一个删除操作处理。");
    }
    inFlight.add(plan.sessionId);

    const record = await beginOperation({
      dataRoot,
      action: "trash",
      extra: { sessionId: plan.sessionId, digest: plan.digest, operator },
    });

    let moved = false;
    let entryId = "";
    /** @type {{ id: string, label: string, status: string, detail?: string }[]} */
    let removed = [];
    try {
      // 1. 先记录引用状态，供恢复时还原 —— **必须早于归档**：
      //    宿主归档会在同一次写里清掉 pin（docs/runtime/0.2.1-rc.5 §6），
      //    归档后再读 storages/workspace.json 只能读到「未置顶」。
      const snapshots = await snapshotAllRefs(refs, plan.sessionId, logger);
      const pinned = snapshots["workspace-pin"]?.pinned;

      // 2. 归档：归档集合就是 provider 的 agent/pre-step 闸门。
      if (caps.checks["workspace.archive"]) {
        await caps.services.workspace.archiveSession(plan.sessionId, { stopActivity: true });
      }
      // 3. 官方停止通道（跑着的轮次、子代理、后台任务、提醒）。
      if (caps.checks["event.session-stop"]) {
        await ctx.parallel("workspace/session-stop", { sessionId: plan.sessionId });
      }
      // 4. 落盘并等写入稳定。
      const live = caps.services.sessions?.get?.(plan.sessionId);
      if (live && caps.checks["sessions.flush"]) await caps.services.sessions.flush(live);
      await delayMs(SETTLE_MS);

      // 5. 移入回收站（原子 rename）。
      const movedResult = await moveIntoTrash({
        dataRoot,
        sessionId: plan.sessionId,
        sourceDir: location.path,
        meta: {
          title:
            plan.title ??
            (typeof request.title === "string" && request.title.length > 0 ? request.title : null),
          cwd: typeof header?.cwd === "string" ? header.cwd : null,
          bytes: plan.sizeBytes ?? 0,
          live: plan.live,
          children: plan.children,
          workspaceIds: snapshots["workspace-slot"]?.workspaceIds ?? [],
          pinned: typeof pinned === "boolean" ? pinned : null,
        },
      });
      moved = true;
      entryId = movedResult.entryId;
      // AUD-SD-01/03：把 entryId 记进 journal —— 崩溃后启动对账能精确知道是哪一条，
      // 已移动但收尾失败的路径也能写出带 entryId 的 partial 回执。
      await updateOperation(dataRoot, record.id, { entryId });

      // 6. 摘掉所有还指向它的引用。
      removed = await removeAllRefs(refs, plan.sessionId, snapshots);

      // 7. 复活复查 + 对账回执。
      //    把本次 entryId 交给守卫：它被 restore/purge 之后就不该再移（B2）。
      scheduleReviveCheck(plan, location.path, entryId);
      const checks = await reconcile(plan.sessionId, { skipDirCheck: true });
      await finishOperation({ dataRoot, id: record.id, state: "done" });
      await note({
        action: "trash",
        result: "ok",
        sessionId: plan.sessionId,
        entryId,
        operator,
        detail: summarizePlan(plan),
      });
      const receiptId = await writeReceipt(dataRoot, {
        action: "trash",
        at: new Date().toISOString(),
        sessionId: plan.sessionId,
        entryId,
        title: plan.title ?? (typeof request.title === "string" ? request.title : null),
        sizeBytes: plan.sizeBytes,
        digest: plan.digest,
        live: plan.live,
        children: plan.children,
        cascaded,
        removed,
        checks,
      });
      return {
        ok: true,
        entryId,
        receiptId,
        cascaded,
        sessionId: plan.sessionId,
        digest: plan.digest,
        title: plan.title ?? (typeof request.title === "string" ? request.title : null),
        sizeBytes: plan.sizeBytes,
        removed,
        checks,
      };
    } catch (error) {
      if (!moved) {
        try {
          await caps.services.workspace?.unarchiveSession?.(plan.sessionId);
        } catch {
          // 尽力而为：回滚归档闸门失败不改变「会话没动过」的事实。
        }
        try {
          await finishOperation({
            dataRoot,
            id: record.id,
            state: "failed",
            detail: messageOf(error),
          });
        } catch (journalError) {
          logger.warn(`session-delete: finishOperation failed: ${messageOf(journalError)}`);
        }
        await note({
          action: "trash",
          result: "failed",
          sessionId: plan.sessionId,
          operator,
          detail: messageOf(error),
        });
        throw failure("session-delete/failed", `删除失败：${messageOf(error)}`, {
          partial: false,
          entryId: null,
        });
      }
      // AUD-SD-03：已移动但收尾失败。磁盘事实是「会话已在回收站」，所以：
      // 审计写明「已进入回收站」，回执标 partial，错误码也单独区分——用户重试会拿到
      // not-found，必须能在回执里看到到底哪一步没做完。
      // 收尾本身也可能坏（例如 journal 目录不可写）：每一步都单独兜住，
      // 否则「二次异常」会把真正的 partial 结论和回执一起吞掉。
      try {
        await finishOperation({
          dataRoot,
          id: record.id,
          state: "failed",
          detail: `已移动但收尾失败：${messageOf(error)}`,
        });
      } catch (journalError) {
        logger.warn(`session-delete: partial finishOperation failed: ${messageOf(journalError)}`);
      }
      const checks = await reconcile(plan.sessionId, { skipDirCheck: true }).catch(
        (/** @type {unknown} */ reconcileError) => [
          {
            id: "reconcile",
            label: "对账",
            status: "skipped",
            detail: `对账失败：${messageOf(reconcileError)}`,
          },
        ],
      );
      /** @type {string | undefined} */
      let receiptId;
      try {
        receiptId = await writeReceipt(dataRoot, {
          action: "trash",
          at: new Date().toISOString(),
          sessionId: plan.sessionId,
          entryId,
          title: plan.title,
          sizeBytes: plan.sizeBytes,
          partial: true,
          removed,
          checks,
        });
      } catch (receiptError) {
        logger.warn(`session-delete: partial receipt failed: ${messageOf(receiptError)}`);
      }
      const cleaned = removed.filter((item) => item.status === "ok").length;
      await note({
        action: "trash",
        result: "failed",
        sessionId: plan.sessionId,
        entryId,
        operator,
        detail: `已移入回收站（${entryId}），引用清理 ${cleaned}/${removed.length} 项后收尾失败：${messageOf(error)}`,
      });
      throw failure(
        "session-delete/partial",
        `会话已移入回收站，但收尾未完成：${messageOf(error)}`,
        { partial: true, entryId, receiptId: receiptId ?? null, removed, checks },
      );
    } finally {
      inFlight.delete(plan.sessionId);
    }
  }

  /** @param {number} [limit] */
  async function auditLog(limit = 100) {
    refreshHost();
    return { path: auditPath(dataRoot), entries: await audit.read(limit) };
  }

  async function list() {
    refreshHost();
    const listed = await listEntries(dataRoot);
    const pending = await listPending(dataRoot);
    return {
      trashRoot: trashRoot(dataRoot),
      entries: listed.entries,
      unknown: listed.unknown,
      pending: pending.map((record) => ({
        id: record.id,
        action: record.action,
        sessionId: record.sessionId,
      })),
    };
  }

  /**
   * 恢复删除前的引用快照（只含有恢复动作的引用）。
   * 条目 meta 在最终化时随条目一起删除，所以重检要用回执里留存的那一份。
   * @param {import("./trash.js").TrashMeta} meta
   * @returns {{ workspaceIds: string[], pinned: boolean | null }}
   */
  function restoredSnapshotOf(meta) {
    return {
      workspaceIds: Array.isArray(meta.workspaceIds) ? meta.workspaceIds : [],
      pinned: typeof meta.pinned === "boolean" ? meta.pinned : null,
    };
  }

  /**
   * 引用恢复 + 自动重试一次（USIM-U3-02）。
   *
   * 为什么重试：失败大多是「宿主刚挂上/写入还在路上」这类瞬时状态，重试一次很便宜；
   * 重试仍然失败的才进回执与界面，并且带上**具体引用名 + 下一步动作**。
   * @param {import("./refs.js").RefSnapshot} snapshot
   * @param {string} sessionId
   */
  async function restoreRefsWithRetry(snapshot, sessionId) {
    refreshHost();
    const first = await restoreAllRefs(refs, sessionId, snapshot);
    const failed = first.filter((item) => item.status === "failed");
    if (failed.length === 0) return first;
    await delayMs(120);
    refreshHost();
    const retried = await restoreAllRefs(refs, sessionId, snapshot, {
      onlyIds: failed.map((item) => item.id),
      retried: true,
    });
    const byId = new Map(retried.map((item) => [item.id, item]));
    return first.map((item) => byId.get(item.id) ?? item);
  }

  /**
   * @param {string} entryId
   * @param {{ operator?: string }} [request]
   */
  async function restore(entryId, request = {}) {
    refreshHost();
    const meta = await readEntry(dataRoot, entryId);
    const operator = request.operator ?? "ui";
    const record = await beginOperation({
      dataRoot,
      action: "restore",
      extra: { sessionId: meta.sessionId, entryId, operator },
    });
    try {
      const restored = await restoreEntry({ dataRoot, entryId });
      // 引用恢复逐项记录：文件回来了只是「会话可用」，归属/置顶回来才算「恢复完整」。
      // 单项失败不再静默 —— 进回执、进 checks、进界面（AUD-SD-02）。
      const snapshot = restoredSnapshotOf(meta);
      const refResults = await restoreRefsWithRetry(snapshot, meta.sessionId);
      const checks = await verifyRestored({
        refs,
        sessionId: meta.sessionId,
        restoredTo: restored.restoredTo,
        meta,
      });
      const summary = restoreSummary(refResults, checks);
      await finishOperation({ dataRoot, id: record.id, state: "done" });
      await note({
        action: "restore",
        result: "ok",
        sessionId: meta.sessionId,
        entryId,
        operator,
        title: meta.title ?? null,
        // 审计要能回答「到底是哪一处没通过」（USIM-U3-05）：计数不够，写清单。
        detail: describeRestoreSummary(summary),
        failures: summary.failures,
      });
      const receiptId = await writeReceipt(dataRoot, {
        action: "restore",
        at: new Date().toISOString(),
        sessionId: meta.sessionId,
        entryId,
        title: meta.title,
        restoredTo: restored.restoredTo,
        // 删除时它是否正在宿主里打开：界面据此提示「仍被标记为忙碌」的下一步。
        wasLive: meta.live === true,
        refs: refResults,
        checks,
        partial: summary.partial,
        // 重检要用的删除前快照：条目已经没了，回执是唯一副本。
        expected: snapshot,
        failures: summary.failures,
      });
      return {
        ok: true,
        sessionId: meta.sessionId,
        title: meta.title ?? null,
        restoredTo: restored.restoredTo,
        wasLive: meta.live === true,
        receiptId,
        refs: refResults,
        checks,
        partial: summary.partial,
        failedRefs: summary.failedRefs,
        failedChecks: summary.failedChecks,
        failures: summary.failures,
      };
    } catch (error) {
      try {
        await finishOperation({
          dataRoot,
          id: record.id,
          state: "failed",
          detail: messageOf(error),
        });
      } catch (journalError) {
        logger.warn(`session-delete: finishOperation failed: ${messageOf(journalError)}`);
      }
      await note({
        action: "restore",
        result: "failed",
        sessionId: meta.sessionId,
        entryId,
        operator,
        detail: messageOf(error),
      });
      throw failure("session-delete/restore-failed", `恢复失败：${messageOf(error)}`);
    }
  }

  /**
   * 重检一次已完成的恢复（USIM-U3-05 的「可操作」出口）：用最近一条 restore 回执里
   * 留存的 `expected` 快照重放引用恢复与校验。失败项仍然失败就照实返回，不伪造成功。
   * @param {{ sessionId?: string, receiptId?: string }} [request]
   */
  async function recheckRestore(request = {}) {
    refreshHost();
    const listed = await listReceipts(dataRoot, 200);
    const candidates = listed.filter(
      (item) => item?.action === "restore" || item?.action === "restore-recheck",
    );
    /** @type {any} */
    let target = null;
    if (typeof request.receiptId === "string" && request.receiptId.length > 0) {
      target = candidates.find((item) => item.id === request.receiptId) ?? null;
    } else if (typeof request.sessionId === "string" && request.sessionId.length > 0) {
      target = candidates.find((item) => item.sessionId === request.sessionId) ?? null;
    }
    if (!target) {
      throw failure(
        "session-delete/not-found",
        "没有找到这次恢复的回执，无法重检（回执可能已被清理）。",
      );
    }
    const sessionId = requireSessionId(target.sessionId);
    // B1（复审）：旧版本写的 restore 回执没有 `expected` 快照。用空快照重放会让
    // `workspace-slot` 以「原本不在任何工作区」返回 ok、校验也只给 skipped，
    // 于是「重检通过」变成假绿（正是本批要消灭的「不伪造成功」）。宁可拒绝：
    // 没有依据就不假装重检成功，让用户按回执里的提示手动处理。
    if (!target.expected || typeof target.expected !== "object") {
      throw failure(
        "session-delete/receipt-legacy",
        "这条回执是旧版本写的，没有留存恢复前的引用快照，不能自动重检；" +
          "请按回执里的提示手动把会话挂回工作区（会话右键菜单「归属到项目…」）。",
      );
    }
    // N13（复审）：快照可能是很久以前留下的。会话目录已经不在时，重放
    // attachSession/pinSession/unarchiveSession 只会对一个不可用的现场做写操作。
    const restoredTo = typeof target.restoredTo === "string" ? target.restoredTo : "";
    const dirOk = await stat(restoredTo)
      .then((value) => value.isDirectory())
      .catch(() => false);
    if (!dirOk) {
      throw failure(
        "session-delete/receipt-stale",
        `回执里记录的会话目录已不存在（${restoredTo || "未知路径"}），` +
          "会话可能又被删除/移动过；请重新确认回收站状态，不要按旧快照重检。",
      );
    }
    /** @type {{ workspaceIds: string[], pinned: boolean | null }} */
    const expected = {
      workspaceIds: Array.isArray(target.expected.workspaceIds)
        ? target.expected.workspaceIds.map(String)
        : [],
      pinned: typeof target.expected.pinned === "boolean" ? target.expected.pinned : null,
    };
    const refResults = await restoreRefsWithRetry(expected, sessionId);
    const checks = await verifyRestored({
      refs,
      sessionId,
      restoredTo: String(target.restoredTo ?? ""),
      meta: expected,
    });
    const summary = restoreSummary(refResults, checks);
    await note({
      action: "restore-recheck",
      result: "ok",
      sessionId,
      operator: "ui",
      title: target.title ?? null,
      detail: describeRestoreSummary(summary),
      failures: summary.failures,
    });
    const receiptId = await writeReceipt(dataRoot, {
      action: "restore-recheck",
      at: new Date().toISOString(),
      sessionId,
      title: target.title ?? null,
      restoredTo: target.restoredTo ?? null,
      refs: refResults,
      checks,
      partial: summary.partial,
      expected,
      failures: summary.failures,
    });
    return {
      ok: !summary.partial,
      sessionId,
      receiptId,
      refs: refResults,
      checks,
      partial: summary.partial,
      failedRefs: summary.failedRefs,
      failedChecks: summary.failedChecks,
      failures: summary.failures,
    };
  }

  /**
   * @param {string} entryId
   * @param {{ operator?: string }} [request]
   */
  async function purge(entryId, request = {}) {
    refreshHost();
    const meta = await readEntry(dataRoot, entryId);
    const record = await beginOperation({
      dataRoot,
      action: "purge",
      extra: { entryId, sessionId: meta.sessionId },
    });
    try {
      const result = await purgeEntry({ dataRoot, entryId });
      await finishOperation({ dataRoot, id: record.id, state: "done" });
      await note({
        action: "purge",
        result: "ok",
        entryId,
        operator: request.operator ?? "ui",
        detail: `释放约 ${result.bytes} 字节`,
      });
      const receiptId = await writeReceipt(dataRoot, {
        action: "purge",
        at: new Date().toISOString(),
        sessionId: meta.sessionId,
        entryId,
        title: meta.title,
        bytes: result.bytes,
      });
      return { ok: true, bytes: result.bytes, sessionId: meta.sessionId, receiptId };
    } catch (error) {
      try {
        await finishOperation({
          dataRoot,
          id: record.id,
          state: "failed",
          detail: messageOf(error),
        });
      } catch (journalError) {
        logger.warn(`session-delete: finishOperation failed: ${messageOf(journalError)}`);
      }
      await note({
        action: "purge",
        result: "failed",
        entryId,
        operator: request.operator ?? "ui",
        detail: messageOf(error),
      });
      throw failure("session-delete/purge-failed", `彻底删除失败：${messageOf(error)}`);
    }
  }

  /**
   * 删除后对账：目录是否消失、每处引用是否还在。
   * @param {string} sessionIdRaw
   * @param {{ skipDirCheck?: boolean }} [options]
   */
  async function reconcile(sessionIdRaw, options = {}) {
    refreshHost();
    const sessionId = requireSessionId(sessionIdRaw);
    /** @type {{ id: string, label: string, status: "ok" | "failed" | "skipped", detail: string }[]} */
    const checks = [];

    if (options.skipDirCheck) {
      checks.push({ id: "session-dir", label: "会话目录", status: "ok", detail: "已移入回收站" });
    } else {
      const located = await locateSession({
        dataRoot,
        sessionId,
        header: undefined,
        persistence: caps.services.persistence,
      });
      checks.push(
        located.location
          ? {
              id: "session-dir",
              label: "会话目录",
              status: "failed",
              detail: `目录仍存在：${located.location.path}`,
            }
          : { id: "session-dir", label: "会话目录", status: "ok", detail: "会话目录已不存在" },
      );
    }

    for (const ref of refs) {
      if (typeof ref.inspect !== "function") continue;
      try {
        checks.push(await ref.inspect(sessionId));
      } catch (error) {
        checks.push({ id: ref.id, label: ref.label, status: "skipped", detail: messageOf(error) });
      }
    }
    return checks;
  }

  /**
   * 全库体检：找出指向已不存在会话的登记条目。只读，不修改任何东西。
   */
  async function scanHealth() {
    refreshHost();
    if (!caps.checks["persistence.list"]) {
      return {
        ok: false,
        reason: "当前宿主没有 sessionPersistence.list，无法枚举已存会话。",
        findings: [],
        inventory: null,
      };
    }
    const persisted = (await caps.services.persistence.list()) ?? [];
    const storedIds = new Set(
      persisted
        .map((/** @type {any} */ entry) => String(entry?.id ?? entry?.header?.id ?? ""))
        .filter(Boolean),
    );
    const liveIds = new Set();
    try {
      for (const id of caps.services.sessions?.store?.keys?.() ?? []) liveIds.add(String(id));
    } catch {
      /* store 不可枚举时忽略 */
    }
    const known = new Set([...storedIds, ...liveIds]);

    const state = await readWorkspaceState(dataRoot);
    /** @type {{ id: string, label: string, severity: "warn" | "info", items: any[] }[]} */
    const findings = [];
    /** @type {{ archived: string[], pinned: string[], workspace: { workspaceId: string, sessionId: string }[] }} */
    const cleanable = { archived: [], pinned: [], workspace: [] };

    if (state.ok) {
      const archivedGhosts = state.archivedIds.filter((id) => !known.has(id));
      const pinnedGhosts = state.pinnedIds.filter((id) => !known.has(id));
      const workspaceGhosts = [];
      for (const workspace of state.workspaces) {
        for (const sessionId of workspace.sessionIds) {
          if (!known.has(sessionId)) workspaceGhosts.push({ workspaceId: workspace.id, sessionId });
        }
      }
      if (archivedGhosts.length > 0) {
        findings.push({
          id: "archived-ghost",
          label: "归档集合里的失效条目",
          severity: "warn",
          items: archivedGhosts,
        });
        cleanable.archived = archivedGhosts;
      }
      if (pinnedGhosts.length > 0) {
        findings.push({
          id: "pinned-ghost",
          label: "置顶集合里的失效条目",
          severity: "warn",
          items: pinnedGhosts,
        });
        cleanable.pinned = pinnedGhosts;
      }
      if (workspaceGhosts.length > 0) {
        findings.push({
          id: "workspace-ghost",
          label: "工作区记账里的失效会话",
          severity: "warn",
          items: workspaceGhosts,
        });
        cleanable.workspace = workspaceGhosts;
      }
    } else {
      findings.push({
        id: "workspace-unreadable",
        label: "无法读取 workspace 存储",
        severity: "info",
        items: [state.reason],
      });
    }

    // 孤儿会话目录：磁盘上有、但持久层与 live 都不认识。仅报告，绝不自动删。
    /** @type {string[]} */
    const orphanDirs = [];
    try {
      const projects = await readdir(sessionsRoot(dataRoot), { withFileTypes: true });
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        const entries = await readdir(join(sessionsRoot(dataRoot), project.name), {
          withFileTypes: true,
        });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const looksLikeSession =
            /^[A-Za-z0-9][A-Za-z0-9_$.-]{0,127}$/u.test(entry.name) || entry.name.includes("~");
          if (looksLikeSession && !known.has(entry.name)) {
            orphanDirs.push(join(project.name, entry.name));
          }
        }
      }
    } catch {
      /* sessions 根不存在时忽略 */
    }
    if (orphanDirs.length > 0) {
      findings.push({
        id: "orphan-session-dir",
        label: "磁盘上的孤儿会话目录（仅报告）",
        severity: "info",
        items: orphanDirs,
      });
    }

    // 回收站一致性：有 meta 没 data
    /** @type {string[]} */
    const brokenTrash = [];
    const listed = await listEntries(dataRoot);
    for (const entry of listed.entries) {
      const exists = await stat(join(trashRoot(dataRoot), entry.entryId, "data"))
        .then((value) => value.isDirectory())
        .catch(() => false);
      if (!exists) brokenTrash.push(entry.entryId);
    }
    if (brokenTrash.length > 0 || listed.unknown.length > 0) {
      findings.push({
        id: "trash-inconsistent",
        label: "回收站条目与实际数据不一致",
        severity: "warn",
        items: [...brokenTrash, ...listed.unknown],
      });
    }

    const pending = await listPending(dataRoot);
    if (pending.length > 0) {
      findings.push({
        id: "pending-operation",
        label: "未完成的操作（重启后自动对账；仍未处理需人工核对）",
        severity: "info",
        items: pending.map((record) => record.id),
      });
    }

    // 读不出来的日志记录：对账会跳过它们，以前连体检也看不见（复审 F4）。只报告、不删除。
    const unreadable = await listUnreadable(dataRoot);
    if (unreadable.length > 0) {
      findings.push({
        id: "journal-unreadable",
        label: `操作日志里有 ${unreadable.length} 条损坏或残留的记录（仅报告，不自动删除）`,
        severity: "info",
        items: unreadable.map((entry) => entry.name),
      });
    }

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      inventory: {
        stored: storedIds.size,
        live: liveIds.size,
        archived: state.archivedIds.length,
        pinned: state.pinnedIds.length,
        workspaces: state.workspaces.length,
        trash: listed.entries.length,
        pending: pending.length,
      },
      findings,
      cleanable: {
        archived: cleanable.archived.length,
        pinned: cleanable.pinned.length,
        workspace: cleanable.workspace.length,
        total: cleanable.archived.length + cleanable.pinned.length + cleanable.workspace.length,
      },
    };
  }

  /**
   * 清理体检发现的失效引用（只动登记表，不碰会话文件）。
   * @param {{ classes?: string[], operator?: string }} [request]
   */
  async function cleanHealth(request = {}) {
    refreshHost();
    const classes = Array.isArray(request.classes)
      ? request.classes
      : ["archived", "pinned", "workspace"];
    const scan = await scanHealth();
    if (!scan.ok)
      throw failure("session-delete/health-unavailable", `无法体检：${scan.reason ?? "未知原因"}`);
    const state = await readWorkspaceState(dataRoot);
    const counts = { archived: 0, pinned: 0, workspace: 0 };
    /** @type {string[]} */
    const errors = [];
    if (classes.includes("archived")) {
      for (const id of state.archivedIds) {
        if (scan.findings.find((f) => f.id === "archived-ghost")?.items.includes(id) !== true)
          continue;
        try {
          await caps.services.workspace?.unarchiveSession?.(id);
          counts.archived += 1;
        } catch (error) {
          errors.push(`unarchive ${id}: ${messageOf(error)}`);
        }
      }
    }
    if (classes.includes("pinned")) {
      for (const id of state.pinnedIds) {
        if (scan.findings.find((f) => f.id === "pinned-ghost")?.items.includes(id) !== true)
          continue;
        try {
          await caps.services.workspace?.unpinSession?.(id);
          counts.pinned += 1;
        } catch (error) {
          errors.push(`unpin ${id}: ${messageOf(error)}`);
        }
      }
    }
    if (classes.includes("workspace")) {
      const ghost = scan.findings.find((f) => f.id === "workspace-ghost");
      for (const item of ghost?.items ?? []) {
        const workspace = (caps.services.workspace?.list?.() ?? []).find(
          (/** @type {any} */ candidate) => String(candidate.id) === String(item.workspaceId),
        );
        if (!workspace || typeof workspace.detachSession !== "function") continue;
        try {
          await workspace.detachSession(item.sessionId);
          counts.workspace += 1;
        } catch (error) {
          errors.push(`detach ${item.sessionId}: ${messageOf(error)}`);
        }
      }
    }
    const total = counts.archived + counts.pinned + counts.workspace;
    await note({
      action: "health",
      result: errors.length > 0 ? "failed" : "ok",
      operator: request.operator ?? "ui",
      detail: `清理失效引用 ${total} 条${errors.length > 0 ? `，失败 ${errors.length} 条` : ""}`,
    });
    const receiptId = await writeReceipt(dataRoot, {
      action: "health",
      at: new Date().toISOString(),
      cleaned: counts,
      total,
      errors,
    });
    return { ok: errors.length === 0, cleaned: counts, total, errors, receiptId };
  }

  /**
   * 读取界面偏好（目前只有确认框里「同时删除子会话」的初值）。
   * 坏文件/坏字段由 preferences.js 统一回落默认值，这里不抛。
   * @returns {Promise<{ version: number, cascadeChildren: boolean }>}
   */
  async function getPrefs() {
    return readPreferences(dataRoot, logger);
  }

  /**
   * 合并写入界面偏好。
   * @param {Record<string, unknown>} patch
   * @returns {Promise<{ version: number, cascadeChildren: boolean }>}
   */
  async function setPrefs(patch = {}) {
    return writePreferences(dataRoot, patch, logger);
  }

  async function health() {
    refreshHost();
    const pending = await listPending(dataRoot);
    return {
      plugin: pkg.name,
      version: pkg.version,
      dataRoot,
      sessionsRoot: sessionsRoot(dataRoot),
      trashRoot: trashRoot(dataRoot),
      capabilities: describeCapabilities(caps),
      pending: pending.length,
      // 启动对账的结论（本轮进程内），磁盘上另有 recover 审计可查。
      lastRecovery,
      readOnly: caps.tier === "unknown",
    };
  }

  /**
   * 启动对账（AUD-SD-01）：扫 journal 的未完成记录，按落盘事实补做或回滚。
   * 幂等，可重复调用；并发调用共用同一次（宿主服务重建时 ctx.inject 会重复触发）。
   * @param {{ operator?: string }} [options]
   */
  async function recoverPending(options = {}) {
    refreshHost();
    if (recoveryInFlight) return recoveryInFlight;
    const job = recovery
      .recoverPending({ operator: options.operator ?? "system" })
      .then((summary) => {
        lastRecovery = summary;
        if (summary.examined > 0) {
          logger.info(
            `session-delete: startup recovery examined ${summary.examined} record(s): ` +
              `${summary.completed} completed / ${summary.rolledBack} rolled back / ` +
              `${summary.unresolved} unresolved / ${summary.failed} failed`,
          );
        }
        return summary;
      })
      .finally(() => {
        recoveryInFlight = null;
      });
    recoveryInFlight = job;
    return job;
  }

  /**
   * 记录一次「拒绝」（AUD-SD-04）。模型工具的 token/stale-plan 拒绝同样要留痕，
   * 否则审计里会出现「20 天 0 条 refused」这种取证缺口。
   * @param {{ sessionId?: string, code?: string, operator?: string, action?: string }} event
   */
  async function recordRefusal(event = {}) {
    const result = await note({
      action: event.action ?? "trash",
      result: "refused",
      sessionId: typeof event.sessionId === "string" ? event.sessionId : undefined,
      operator: event.operator ?? "agent",
      detail: event.code ?? "refused",
    });
    return { ok: result.ok };
  }

  /**
   * 批量恢复回收站条目。
   * @param {{ entryIds?: string[], operator?: string }} request
   */
  async function restoreMany(request = {}) {
    const ids = Array.isArray(request.entryIds) ? request.entryIds : [];
    if (ids.length === 0) throw failure("session-delete/invalid-request", "没有选择任何条目");
    if (ids.length > MAX_BATCH_IDS) {
      throw failure(
        "session-delete/invalid-request",
        `一次最多 ${MAX_BATCH_IDS} 条（界面会自动分批）`,
      );
    }
    /** @type {{ entryId: string, ok: boolean, sessionId?: string, partial?: boolean, error?: string }[]} */
    const results = [];
    for (const entryId of ids) {
      try {
        const result = await restore(entryId, { operator: request.operator ?? "ui" });
        // partial 也要带出去：批量行要能说「其中 N 条引用没还原」。
        results.push({
          entryId,
          ok: true,
          sessionId: result.sessionId,
          partial: result.partial === true,
        });
      } catch (error) {
        results.push({ entryId, ok: false, error: messageOf(error) });
      }
    }
    const okCount = results.filter((item) => item.ok).length;
    return { ok: okCount === results.length, total: results.length, succeeded: okCount, results };
  }

  /**
   * 批量彻底删除回收站条目。
   * @param {{ entryIds?: string[], operator?: string }} request
   */
  async function purgeMany(request = {}) {
    const ids = Array.isArray(request.entryIds) ? request.entryIds : [];
    if (ids.length === 0) throw failure("session-delete/invalid-request", "没有选择任何条目");
    if (ids.length > MAX_BATCH_IDS) {
      throw failure(
        "session-delete/invalid-request",
        `一次最多 ${MAX_BATCH_IDS} 条（界面会自动分批）`,
      );
    }
    /** @type {{ entryId: string, ok: boolean, bytes?: number, error?: string }[]} */
    const results = [];
    for (const entryId of ids) {
      try {
        const result = await purge(entryId, { operator: request.operator ?? "ui" });
        results.push({ entryId, ok: true, bytes: result.bytes });
      } catch (error) {
        results.push({ entryId, ok: false, error: messageOf(error) });
      }
    }
    const okCount = results.filter((item) => item.ok).length;
    return { ok: okCount === results.length, total: results.length, succeeded: okCount, results };
  }

  /**
   * 工作区记账里的成员会话。侧栏的工作区分组就是这份清单一族（组内 = 这些 id 里
   * 还能在会话列表里找到的那些），所以「删这个工作区的会话」＝ 这里返回的 id。
   * 优先读 host workspaceRegistry（活状态）；没有该服务时回落到 workspace.json（只读兜底）。
   * @param {unknown} workspaceIdRaw
   * @returns {Promise<{ workspaceId: string, title: string | null, sessionIds: string[] }>}
   */
  async function workspaceMembers(workspaceIdRaw) {
    const workspaceId = typeof workspaceIdRaw === "string" ? workspaceIdRaw.trim() : "";
    if (workspaceId.length === 0) {
      throw failure("session-delete/invalid-request", "缺少工作区 id");
    }
    const registry = caps.services.workspace;
    if (typeof registry?.list === "function") {
      try {
        const rows = registry.list() ?? [];
        const found = rows.find((/** @type {any} */ row) => String(row?.id) === workspaceId);
        if (found) {
          return {
            workspaceId,
            title: typeof found.title === "string" ? found.title : null,
            sessionIds: Array.isArray(found.sessionIds) ? found.sessionIds.map(String) : [],
          };
        }
      } catch (error) {
        logger.warn(`session-delete: workspaceRegistry.list failed: ${messageOf(error)}`);
      }
    }
    // 文件兜底：老版本/headless 组合里没有 workspaceRegistry。
    const state = await readWorkspaceState(dataRoot);
    const fromFile = state.workspaces.find((row) => row.id === workspaceId);
    if (fromFile) {
      return { workspaceId, title: null, sessionIds: fromFile.sessionIds.map(String) };
    }
    throw failure("session-delete/not-found", `找不到工作区 ${workspaceId}`, { workspaceId });
  }

  /**
   * 工作区级影响面（dry-run）。逐个会话算 plan，跳过已经不存在的（登记表幽灵），
   * 聚合成一份带 digest 的预览，供确认框一次性展示。
   * @param {unknown} workspaceIdRaw
   * @returns {Promise<any>}
   */
  async function planWorkspace(workspaceIdRaw) {
    const workspace = await workspaceMembers(workspaceIdRaw);
    /** @type {unknown[] | undefined} */
    let all;
    if (caps.checks["persistence.list"] && caps.services.persistence?.list) {
      try {
        all = (await caps.services.persistence.list()) ?? [];
      } catch (error) {
        logger.warn(`session-delete: persistence.list failed: ${messageOf(error)}`);
      }
    }
    /** @type {{ sessionId: string, title: string | null, sizeBytes: number | null, live: boolean,
     *   children: { id: string, title: string | null }[], blockers: { code: string, message: string }[],
     *   digest: string }[]} */
    const sessions = [];
    /** @type {string[]} */
    const missing = [];
    for (const sessionId of workspace.sessionIds) {
      try {
        const { plan } = await makePlan(sessionId, { all });
        sessions.push({
          sessionId: plan.sessionId,
          title: plan.title,
          sizeBytes: plan.sizeBytes,
          live: plan.live,
          children: plan.children,
          blockers: plan.blockers,
          digest: plan.digest,
        });
      } catch (error) {
        // 登记表里指向已不存在的会话：跳过而不是整单失败（体检会单独报告它们）。
        if (/** @type {any} */ (error)?.code === "session/not-found") {
          missing.push(sessionId);
          continue;
        }
        throw error;
      }
    }
    let sizeBytes = 0;
    let live = 0;
    let children = 0;
    let blocked = 0;
    for (const session of sessions) {
      if (typeof session.sizeBytes === "number") sizeBytes += session.sizeBytes;
      if (session.live) live += 1;
      children += session.children.length;
      if (session.blockers.length > 0) blocked += 1;
    }
    return {
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      sessions,
      total: sessions.length,
      missing,
      sizeBytes,
      live,
      children,
      blocked,
      digest: digestOfWorkspace({ workspaceId: workspace.workspaceId, sessions }),
    };
  }

  /**
   * 工作区级批量删除：逐条走既有的 trash（各自的归档闸门、停止、引用清理、审计与回执），
   * 汇总部分失败而不是中途放弃——一个卡住的会话不应该让其余会话留在磁盘上。
   * @param {unknown} workspaceIdRaw
   * @param {{ digest?: string, cascade?: boolean, operator?: string }} [request]
   * @returns {Promise<any>}
   */
  async function trashWorkspace(workspaceIdRaw, request = {}) {
    const preview = await planWorkspace(workspaceIdRaw);
    if (request.digest && request.digest !== preview.digest) {
      throw failure(
        "session-delete/stale-plan",
        "这个工作区的会话在确认期间发生了变化，请重新查看影响面。",
        { workspaceId: preview.workspaceId, expected: preview.digest, actual: request.digest },
      );
    }
    const cascade = request.cascade === true;
    const operator = request.operator ?? "ui";
    /** @type {unknown[] | undefined} */
    let all;
    if (caps.checks["persistence.list"] && caps.services.persistence?.list) {
      try {
        all = (await caps.services.persistence.list()) ?? [];
      } catch (error) {
        logger.warn(`session-delete: persistence.list failed: ${messageOf(error)}`);
      }
    }
    /** @type {{ sessionId: string, title: string | null, ok: boolean, entryId?: string, children?: number, error?: string }[]} */
    const results = [];
    for (const session of preview.sessions) {
      try {
        const result = await trash(session.sessionId, {
          digest: session.digest,
          cascade,
          operator,
          all,
        });
        results.push({
          sessionId: session.sessionId,
          title: session.title,
          ok: true,
          entryId: result.entryId,
          children: Array.isArray(result.cascaded) ? result.cascaded.length : 0,
        });
      } catch (error) {
        results.push({
          sessionId: session.sessionId,
          title: session.title,
          ok: false,
          error: messageOf(error),
        });
      }
    }
    const okCount = results.filter((item) => item.ok).length;
    // 一次批量一条汇总审计：逐条的 trash 记录已经在 trash() 里写过了。
    await audit
      .append({
        action: "trash",
        result: okCount === results.length ? "ok" : "failed",
        operator,
        detail: `workspace ${preview.workspaceId}: ${okCount}/${results.length} 个会话，含 ${preview.children} 个子会话，cascade=${cascade}`,
      })
      .catch(() => {});
    return {
      ok: okCount === results.length,
      workspaceId: preview.workspaceId,
      total: results.length,
      succeeded: okCount,
      results,
    };
  }

  /** @param {number} [limit] */
  async function receipts(limit = 50) {
    refreshHost();
    return { entries: await listReceipts(dataRoot, limit) };
  }

  return {
    get caps() {
      return refreshHost();
    },
    // 启动对账与复活守卫的实现（暴露出来是为了单测能直接驱动它，不是公开契约）。
    recovery,
    recoverPending,
    recordRefusal,
    health,
    restoreMany,
    purgeMany,
    receipts,
    scanHealth,
    cleanHealth,
    plan: /** @param {unknown} sessionId */ async (sessionId) => (await makePlan(sessionId)).plan,
    trash,
    list,
    restore,
    recheckRestore,
    purge,
    reconcile,
    auditLog,
    getPrefs,
    setPrefs,
    planWorkspace,
    trashWorkspace,
  };
}
