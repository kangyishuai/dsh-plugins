// @ts-check
// 操作编排层：不依赖 typert，可在单元测试里用假 ctx 跑（真实宿主交互全部经 capability.js 探测）。
import { createRequire } from "node:module";
import { setTimeout as delayMs } from "node:timers/promises";
import { createAudit } from "./audit.js";
import { describeCapabilities, probeCapabilities } from "./capability.js";
import { beginOperation, finishOperation, listPending } from "./journal.js";
import { directorySize, locateSession } from "./locate.js";
import { auditPath, requireSessionId, sessionsRoot, trashRoot } from "./paths.js";
import { buildPlan, planExecutable, summarizePlan } from "./plan.js";
import { buildRefs } from "./refs.js";
import { listEntries, moveIntoTrash, purgeEntry, readEntry, restoreEntry } from "./trash.js";

const nodeRequire = createRequire(import.meta.url);
const pkg = nodeRequire("../package.json");

/** 等宿主把 flush / 取消落盘写完再动文件。 */
const SETTLE_MS = 200;
/** 移走之后复查原路径的时间点；活句柄迟到写入会在这个窗口里重建目录。 */
const REVIVE_CHECK_MS = 1500;

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
  const caps = probeCapabilities(ctx);
  const audit = createAudit(dataRoot);
  const refs = buildRefs(caps, logger);
  /** 当前进程里正在操作中的会话，防止双击/并发把同一个会话删两遍。 */
  const inFlight = new Set();

  /**
   * 收集一份完整事实并生成 Plan。
   * @param {unknown} sessionIdRaw
   */
  async function makePlan(sessionIdRaw) {
    const sessionId = requireSessionId(sessionIdRaw);
    /** @type {string[]} */
    const notes = [];

    let stored;
    try {
      stored = await caps.services.persistence?.stat?.(sessionId);
    } catch (error) {
      notes.push("stat failed: " + messageOf(error));
    }
    const liveEntry = caps.services.sessions?.get?.(sessionId);
    if (!stored && !liveEntry) {
      throw failure("session/not-found", "no session named " + sessionId, { sessionId });
    }
    const header = stored?.header ?? liveEntry?.header ?? null;

    /** @type {unknown[]} */
    let rawActivity = [];
    if (typeof ctx.waterfall === "function") {
      try {
        rawActivity = await ctx.waterfall("workspace/session-activity", { sessionId }, () => []);
      } catch (error) {
        notes.push("activity unavailable: " + messageOf(error));
      }
    }
    const activity = normalizeActivity(rawActivity);
    const subagents = activity.find((group) => group.kind === "subagent");
    const children = (subagents?.ids ?? []).map((id, index) => ({
      id,
      title: subagents?.labels[index] ?? null,
    }));

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
              message: "同一会话在 " + ambiguous.length + " 个项目目录下都有副本，已拒绝操作。",
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
   * 移走之后复查一次原路径；目录若被迟到写入重建，就再移一次并记审计。
   * @param {string} sessionId
   * @param {string} originalPath
   */
  function scheduleReviveCheck(sessionId, originalPath) {
    const timer = setTimeout(async () => {
      try {
        const { stat } = await import("node:fs/promises");
        const exists = await stat(originalPath)
          .then(() => true)
          .catch(() => false);
        if (!exists) return;
        await audit.append({
          action: "trash",
          result: "ok",
          sessionId,
          operator: "system",
          detail: "会话目录在移走后被重建，已记录（复活守卫）",
        });
        logger.warn("session-delete: session " + sessionId + " was recreated after deletion");
      } catch (error) {
        logger.warn("session-delete: revive check failed: " + messageOf(error));
      }
    }, REVIVE_CHECK_MS);
    /** @type {any} */ (timer).unref?.();
  }

  /**
   * @param {string} sessionIdRaw
   * @param {{ digest?: string, title?: string | null, operator?: string }} request
   */
  async function trash(sessionIdRaw, request = {}) {
    const loaded = await makePlan(sessionIdRaw);
    const { plan, location, header } = loaded;
    if (request.digest && request.digest !== plan.digest) {
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
      await audit.append({
        action: "trash",
        result: "refused",
        sessionId: plan.sessionId,
        operator: request.operator ?? "ui",
        detail: plan.blockers.map((b) => b.code).join(","),
      });
      throw failure("session-delete/blocked", plan.blockers[0].message, {
        blockers: plan.blockers,
        plan,
      });
    }
    if (!location) throw failure("session-delete/location-unknown", "没有可移动的会话目录");
    if (inFlight.has(plan.sessionId)) {
      throw failure("session-delete/busy", "这个会话正在被另一个删除操作处理。");
    }
    inFlight.add(plan.sessionId);

    const record = await beginOperation({
      dataRoot,
      action: "trash",
      extra: { sessionId: plan.sessionId, digest: plan.digest, operator: request.operator ?? "ui" },
    });

    let moved = false;
    let entryId = "";
    try {
      // 1. 先归档：归档集合就是 provider 的 agent/pre-step 闸门。
      if (caps.checks["workspace.archive"]) {
        await caps.services.workspace.archiveSession(plan.sessionId, { stopActivity: true });
      }
      // 2. 官方停止通道（跑着的轮次、子代理、后台任务、提醒）。
      if (caps.checks["event.session-stop"]) {
        await ctx.parallel("workspace/session-stop", { sessionId: plan.sessionId });
      }
      // 3. 落盘并等写入稳定。
      const live = caps.services.sessions?.get?.(plan.sessionId);
      if (live && caps.checks["sessions.flush"]) await caps.services.sessions.flush(live);
      await delayMs(SETTLE_MS);

      // 4. 记录引用状态，供恢复时还原。
      /** @type {Record<string, any>} */
      const snapshots = {};
      for (const ref of refs) {
        if (typeof ref.snapshot !== "function") continue;
        try {
          snapshots[ref.id] = await ref.snapshot(plan.sessionId);
        } catch (error) {
          logger.warn("session-delete: snapshot " + ref.id + " failed: " + messageOf(error));
        }
      }

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
          pinned: null,
        },
      });
      moved = true;
      entryId = movedResult.entryId;

      // 6. 摘掉所有还指向它的引用。
      /** @type {{ id: string, label: string, status: string, detail?: string }[]} */
      const removed = [];
      for (const ref of refs) {
        if (typeof ref.remove !== "function" || ref.tier === "unknown") {
          removed.push({
            id: ref.id,
            label: ref.label,
            status: "skipped",
            detail: "当前宿主不提供该接口",
          });
          continue;
        }
        try {
          await ref.remove(plan.sessionId, snapshots[ref.id] ?? {});
          removed.push({ id: ref.id, label: ref.label, status: "ok" });
        } catch (error) {
          removed.push({
            id: ref.id,
            label: ref.label,
            status: "failed",
            detail: messageOf(error),
          });
        }
      }

      // 7. 复活复查 + 对账回执。
      scheduleReviveCheck(plan.sessionId, location.path);
      const checks = await reconcile(plan.sessionId, { skipDirCheck: true });
      await finishOperation({ dataRoot, id: record.id, state: "done" });
      await audit.append({
        action: "trash",
        result: "ok",
        sessionId: plan.sessionId,
        entryId,
        operator: request.operator ?? "ui",
        detail: summarizePlan(plan),
      });
      return {
        ok: true,
        entryId,
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
          // 尽力而为。
        }
      }
      await finishOperation({ dataRoot, id: record.id, state: "failed", detail: messageOf(error) });
      await audit.append({
        action: "trash",
        result: "failed",
        sessionId: plan.sessionId,
        operator: request.operator ?? "ui",
        detail: messageOf(error),
      });
      throw failure("session-delete/failed", "删除失败：" + messageOf(error), {
        partial: moved,
        entryId: moved ? entryId : null,
      });
    } finally {
      inFlight.delete(plan.sessionId);
    }
  }

  /** @param {number} [limit] */
  async function auditLog(limit = 100) {
    return { path: auditPath(dataRoot), entries: await audit.read(limit) };
  }

  async function list() {
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
   * @param {string} entryId
   * @param {{ operator?: string }} [request]
   */
  async function restore(entryId, request = {}) {
    const meta = await readEntry(dataRoot, entryId);
    const record = await beginOperation({
      dataRoot,
      action: "restore",
      extra: { sessionId: meta.sessionId, entryId },
    });
    try {
      const restored = await restoreEntry({ dataRoot, entryId });
      try {
        await caps.services.workspace?.unarchiveSession?.(meta.sessionId);
      } catch {
        // 恢复失败不阻断：文件已经回去了。
      }
      for (const ref of refs) {
        if (typeof ref.restore !== "function") continue;
        try {
          await ref.restore(meta.sessionId, {
            workspaceIds: meta.workspaceIds,
            pinned: meta.pinned,
          });
        } catch (error) {
          logger.warn("session-delete: restore " + ref.id + " failed: " + messageOf(error));
        }
      }
      await finishOperation({ dataRoot, id: record.id, state: "done" });
      await audit.append({
        action: "restore",
        result: "ok",
        sessionId: meta.sessionId,
        entryId,
        operator: request.operator ?? "ui",
      });
      return { ok: true, sessionId: meta.sessionId, restoredTo: restored.restoredTo };
    } catch (error) {
      await finishOperation({ dataRoot, id: record.id, state: "failed", detail: messageOf(error) });
      await audit.append({
        action: "restore",
        result: "failed",
        sessionId: meta.sessionId,
        entryId,
        operator: request.operator ?? "ui",
        detail: messageOf(error),
      });
      throw failure("session-delete/restore-failed", "恢复失败：" + messageOf(error));
    }
  }

  /**
   * @param {string} entryId
   * @param {{ operator?: string }} [request]
   */
  async function purge(entryId, request = {}) {
    const meta = await readEntry(dataRoot, entryId);
    const record = await beginOperation({
      dataRoot,
      action: "purge",
      extra: { entryId, sessionId: meta.sessionId },
    });
    try {
      const result = await purgeEntry({ dataRoot, entryId });
      await finishOperation({ dataRoot, id: record.id, state: "done" });
      await audit.append({
        action: "purge",
        result: "ok",
        entryId,
        operator: request.operator ?? "ui",
        detail: "释放约 " + result.bytes + " 字节",
      });
      return { ok: true, bytes: result.bytes, sessionId: meta.sessionId };
    } catch (error) {
      await finishOperation({ dataRoot, id: record.id, state: "failed", detail: messageOf(error) });
      await audit.append({
        action: "purge",
        result: "failed",
        entryId,
        operator: request.operator ?? "ui",
        detail: messageOf(error),
      });
      throw failure("session-delete/purge-failed", "彻底删除失败：" + messageOf(error));
    }
  }

  /**
   * 删除后对账：目录是否消失、每处引用是否还在。
   * @param {string} sessionIdRaw
   * @param {{ skipDirCheck?: boolean }} [options]
   */
  async function reconcile(sessionIdRaw, options = {}) {
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
              detail: "目录仍存在：" + located.location.path,
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

  async function health() {
    const pending = await listPending(dataRoot);
    return {
      plugin: pkg.name,
      version: pkg.version,
      dataRoot,
      sessionsRoot: sessionsRoot(dataRoot),
      trashRoot: trashRoot(dataRoot),
      capabilities: describeCapabilities(caps),
      pending: pending.length,
      readOnly: caps.tier === "unknown",
    };
  }

  return {
    caps,
    health,
    plan: /** @param {unknown} sessionId */ async (sessionId) => (await makePlan(sessionId)).plan,
    trash,
    list,
    restore,
    purge,
    reconcile,
    auditLog,
  };
}
