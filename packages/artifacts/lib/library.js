// @ts-check
// 跨插件契约层：把「存储 + 过滤 + 级联」包成带 `{ ok, code }` 信封的稳定方法集。
//
// 为什么单独一层（docs/plugin-conventions.md §8）：
//   - `service.js` 只能声明 Remote，没法在单测里 import（宿主包 `@deepseek-ai/dsh-typert-protocol`
//     运行时才注入，仓库里解析不到）；把契约逻辑放这里，`pnpm test` 就能覆盖参数校验、错误码、
//     dry-run、级联范围、路径穿越拒绝这些"跨插件承诺"；
//   - 因此这一层的方法集 == Remote 方法集（`test/remote-declarations.test.js` 静态对账）；
//   - 返回值只放可 JSON 化的字段：Buffer 不上行，二进制一律给 URL。
//
// 错误契约：**任何方法都不向调用方抛异常**。参数不合法、id 不安全、文件系统读写失败
// （EACCES/ENOSPC/磁盘消失）都变成 `{ ok:false, code, message, processed?, ... }`，
// 好让调用方的降级分支只需要看 `ok`（§8.4）。
import { readFileSync } from "node:fs";
import {
  ARTIFACT_CONTRACT,
  ARTIFACT_KINDS,
  ArtifactError,
  isTextKind,
  latestBytes,
  MAX_BYTES,
  summarizeArtifacts,
  totalBytes,
} from "./store.js";

/** 插件自身的包名/版本：`version()` 里回给调用方，便于排查"装的是哪一版"。 */
const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** 契约版本（`artifacts/2`）。破坏性改动才 +1，跟插件版本独立。 */
export const CONTRACT = ARTIFACT_CONTRACT;

/** 契约方法集：远程方法、文档、`version()` 的 `methods` 三处必须一致。 */
export const LIBRARY_METHODS = Object.freeze([
  "list",
  "latest",
  "version",
  "archive",
  "remove",
  "restore",
  "trash",
  "purge",
]);

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   kind: string,
 *   mime: string,
 *   latest: number,
 *   bytes: number,
 *   totalBytes: number,
 *   createdAt: number,
 *   updatedAt: number,
 *   projectId: string | null,
 *   sessionId: string | null,
 *   threadId: string | null,
 *   source: { sessionId: string | null, toolCallId: string | null, via: string | null } | null,
 *   archived: boolean,
 *   archivedAt: number | null,
 *   coverUrl: string,
 *   previewUrl: string,
 *   downloadUrl: string,
 * }} ArtifactRow
 * @typedef {{ ok: false, code: string, message: string }} Failure
 */

/** @param {unknown} value @returns {string | null} */
function textOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** @param {unknown} value @returns {string[]} */
function idsOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
  }
  return out;
}

/**
 * @param {string} code
 * @param {string} message
 * @returns {Failure}
 */
function failure(code, message) {
  return { ok: false, code, message };
}

/**
 * 异常 → 错误信封（§8.4）。非 `ArtifactError` 一律记成 `artifacts/failed`，
 * 但 message 原样保留（调用方/日志能看出是 EACCES 还是 ENOSPC）。
 * @param {unknown} error
 * @param {Record<string, unknown>} [extra] 失败时也要带上的上下文（dryRun、processed 等）
 * @returns {Record<string, unknown>}
 */
function failureOf(error, extra = {}) {
  const code =
    error instanceof ArtifactError
      ? error.code
      : typeof (/** @type {any} */ (error)?.code) === "string"
        ? /** @type {any} */ (error).code
        : "artifacts/failed";
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, code, message, ...extra };
}

/**
 * 参数的公共校验：`dryRun` / `archived` 必须是 boolean，`ids` 必须是非空字符串数组。
 * @param {any} request
 * @param {{ archived?: boolean }} [options]
 * @returns {Failure | null}
 */
function validateWriteRequest(request, options = {}) {
  const r = request ?? {};
  if (r.dryRun !== undefined && typeof r.dryRun !== "boolean")
    return failure("artifacts/invalid", "dryRun must be a boolean");
  if (options.archived === true && r.archived !== undefined && typeof r.archived !== "boolean")
    return failure("artifacts/invalid", "archived must be a boolean");
  if (r.ids !== undefined) {
    if (!Array.isArray(r.ids))
      return failure("artifacts/invalid", "ids must be an array of strings");
    if (r.ids.some((/** @type {unknown} */ item) => typeof item !== "string" || item.trim() === ""))
      return failure("artifacts/invalid", "ids must be an array of non-empty strings");
  }
  if (r.projectId !== undefined && r.projectId !== null && typeof r.projectId !== "string")
    return failure("artifacts/invalid", "projectId must be a string or null");
  if (typeof r.projectId === "string" && r.projectId.trim() === "")
    return failure("artifacts/invalid", "projectId must not be empty");
  return null;
}

/**
 * `list` 的参数校验：非字符串 projectId、`limit <= 0` 之类一律报错，**不静默兜底**——
 * 静默把 `projectId: 123` 当成"不过滤"会让调用方以为拿到了项目产物。
 * @param {any} request
 * @returns {Failure | null}
 */
function validateListRequest(request) {
  const r = request ?? {};
  if (
    Object.hasOwn(r, "projectId") &&
    r.projectId !== undefined &&
    r.projectId !== null &&
    typeof r.projectId !== "string"
  )
    return failure("artifacts/invalid", "projectId must be a string or null");
  if (typeof r.projectId === "string" && r.projectId.trim() === "")
    return failure("artifacts/invalid", "projectId must not be empty");
  for (const key of ["sessionId", "threadId", "title"]) {
    if (r[key] !== undefined && typeof r[key] !== "string")
      return failure("artifacts/invalid", `${key} must be a string`);
  }
  if (r.kind !== undefined) {
    const kinds = Array.isArray(r.kind) ? r.kind : [r.kind];
    if (kinds.some((/** @type {unknown} */ value) => typeof value !== "string"))
      return failure("artifacts/invalid", "kind must be a string or an array of strings");
  }
  for (const key of ["since", "until"]) {
    if (r[key] !== undefined && (typeof r[key] !== "number" || !Number.isFinite(r[key])))
      return failure("artifacts/invalid", `${key} must be a finite number (epoch ms)`);
  }
  if (
    r.limit !== undefined &&
    (typeof r.limit !== "number" || !Number.isInteger(r.limit) || r.limit <= 0)
  )
    return failure("artifacts/invalid", "limit must be a positive integer");
  return null;
}

/**
 * meta → 对外行。URL 是**相对路径**，客户端按页面 origin 直接用。
 * @param {import("./store.js").ArtifactMeta} meta
 * @param {string} routePrefix
 * @returns {ArtifactRow}
 */
export function publicArtifact(meta, routePrefix = "/artifacts") {
  const base = `${routePrefix}/${encodeURIComponent(meta.id)}`;
  const source = meta.source;
  return {
    id: meta.id,
    title: meta.title,
    kind: meta.kind,
    mime: meta.mime,
    latest: meta.latest,
    bytes: latestBytes(meta),
    totalBytes: totalBytes(meta),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    projectId: textOrNull(meta.projectId),
    sessionId: textOrNull(meta.sessionId),
    threadId: textOrNull(meta.threadId),
    source:
      source === undefined
        ? null
        : {
            sessionId: textOrNull(source.sessionId),
            toolCallId: textOrNull(source.toolCallId),
            via: textOrNull(source.via),
          },
    archived: meta.archived === true,
    archivedAt: meta.archived === true ? (meta.archivedAt ?? null) : null,
    coverUrl: `${base}/cover.svg`,
    previewUrl: base,
    downloadUrl: `${base}?download=1`,
  };
}

/**
 * 影响面：给 dry-run 与真实执行共用的"将要/已经动了什么"。
 * @param {import("./store.js").ArtifactMeta[]} metas
 * @returns {{ count: number, bytes: number, ids: string[] }}
 */
function impactOf(metas) {
  return {
    count: metas.length,
    bytes: metas.reduce((sum, meta) => sum + latestBytes(meta), 0),
    ids: metas.map((meta) => meta.id),
  };
}

/**
 * 请求里有没有"要动哪些"的选择器（`ids` 或 `projectId`）。
 * 没有选择器时级联方法一律拒绝——不允许"没传参数 = 清空整个库"。
 * @param {{ ids?: unknown, projectId?: unknown }} request
 * @returns {boolean}
 */
function hasSelector(request) {
  return idsOf(request.ids).length > 0 || textOrNull(request.projectId) !== null;
}

/**
 * @param {{ store: ReturnType<typeof import("./store.js").createArtifactStore>, routePrefix?: string }} deps
 */
export function createArtifactLibrary({ store, routePrefix = "/artifacts" }) {
  /**
   * 解析级联目标：`ids` 优先；否则按 `projectId` 扫（含已归档，删除/归档都要清干净）。
   * @param {{ ids?: unknown, projectId?: unknown, includeArchived?: boolean }} request
   * @returns {Promise<{ metas: import("./store.js").ArtifactMeta[], unknown: string[] }>}
   */
  async function resolveTargets(request) {
    const ids = idsOf(request.ids);
    /** @type {import("./store.js").ArtifactMeta[]} */
    const metas = [];
    /** @type {string[]} */
    const unknown = [];
    if (ids.length > 0) {
      for (const id of ids) {
        const meta = await store.readMeta(id);
        if (meta === undefined) unknown.push(id);
        else metas.push(meta);
      }
      return { metas, unknown };
    }
    const projectId = textOrNull(request.projectId);
    if (projectId === null) return { metas, unknown };
    const rows = await store.list({
      projectId,
      includeArchived: request.includeArchived !== false,
    });
    return { metas: rows, unknown };
  }

  return {
    /**
     * 列表 + 汇总。不传 `projectId` = 全量（0.1.0 的行为）。
     * @param {any} [request]
     * @returns {Promise<any>}
     */
    async list(request = {}) {
      const invalid = validateListRequest(request);
      if (invalid !== null) return invalid;
      try {
        /** @type {import("./store.js").ListOptions} */
        const options = {};
        // `projectId: null` = 只列"没有归属"的产物；`undefined`/缺省 = 不按项目过滤。
        if (Object.hasOwn(request ?? {}, "projectId") && request?.projectId !== undefined)
          options.projectId = request.projectId === null ? null : request.projectId;
        if (request?.sessionId !== undefined) options.sessionId = request.sessionId;
        if (request?.threadId !== undefined) options.threadId = request.threadId;
        if (request?.kind !== undefined) options.kind = request.kind;
        if (request?.title !== undefined) options.title = request.title;
        if (request?.since !== undefined) options.since = request.since;
        if (request?.until !== undefined) options.until = request.until;
        if (request?.includeArchived !== undefined)
          options.includeArchived = request.includeArchived;
        if (request?.onlyArchived !== undefined) options.onlyArchived = request.onlyArchived;
        if (request?.limit !== undefined) options.limit = request.limit;
        const rows = await store.list(options);
        return {
          ok: true,
          contract: CONTRACT,
          artifacts: rows.map((meta) => publicArtifact(meta, routePrefix)),
          summary: summarizeArtifacts(rows),
        };
      } catch (error) {
        return failureOf(error);
      }
    },

    /**
     * 轮询/预览用：`since === 当前版本` 时只回 "没变"，避免 1s 轮询重复传正文。
     * `changed:false` 也带 `kind`，客户端不需要再猜类型。
     * @param {any} [request]
     * @returns {Promise<any>}
     */
    async latest(request) {
      const id = typeof request?.id === "string" ? request.id : "";
      if (id === "") return failure("artifacts/invalid", "latest needs an id");
      try {
        const found = await store.read(id);
        if (found === undefined) return failure("artifacts/not-found", `unknown artifact: ${id}`);
        const rowMeta = publicArtifact(found.meta, routePrefix);
        const since = Number(request?.since);
        if (Number.isInteger(since) && since === found.version) {
          return {
            ok: true,
            contract: CONTRACT,
            id,
            title: found.meta.title,
            kind: found.kind,
            mime: found.mime,
            version: found.version,
            bytes: found.bytes,
            changed: false,
          };
        }
        /** @type {any} */
        const payload = {
          ok: true,
          contract: CONTRACT,
          id,
          title: found.meta.title,
          kind: found.kind,
          mime: found.mime,
          version: found.version,
          versions: found.meta.versions.map((item) => item.version),
          bytes: found.bytes,
          totalBytes: rowMeta.totalBytes,
          createdAt: found.meta.createdAt,
          updatedAt: found.meta.updatedAt,
          projectId: rowMeta.projectId,
          sessionId: rowMeta.sessionId,
          threadId: rowMeta.threadId,
          source: rowMeta.source,
          archived: rowMeta.archived,
          changed: true,
          coverUrl: rowMeta.coverUrl,
          previewUrl: rowMeta.previewUrl,
          downloadUrl: rowMeta.downloadUrl,
          // 版本自身的来源：能反查"这一版是哪次线程/哪次工具调用产出的"。
          versionSource: found.meta.versions[found.version - 1]?.source ?? null,
        };
        if (found.kind === "html") payload.html = found.html;
        if (isTextKind(found.kind)) payload.text = found.text;
        return payload;
      } catch (error) {
        return failureOf(error);
      }
    },

    /**
     * 契约探针：调用方先问版本，再决定用哪些字段。
     * @returns {Promise<any>}
     */
    async version() {
      return {
        ok: true,
        service: "artifacts",
        plugin: PACKAGE.name,
        packageVersion: PACKAGE.version,
        contract: CONTRACT,
        kinds: [...ARTIFACT_KINDS],
        maxBytes: MAX_BYTES,
        methods: [...LIBRARY_METHODS],
      };
    },

    /**
     * 归档 / 取消归档（归档后只读 + 默认不在列表里）。
     * @param {any} [request] `{ ids?, projectId?, archived?, dryRun? }`
     * @returns {Promise<any>}
     */
    async archive(request = {}) {
      const archived = request?.archived !== false;
      const dryRun = request?.dryRun === true;
      const invalid = validateWriteRequest(request, { archived: true });
      if (invalid !== null) return invalid;
      if (!hasSelector(request ?? {}))
        return failure("artifacts/invalid", "archive needs ids or projectId");
      /** @type {string[]} */
      const processed = [];
      try {
        const { metas, unknown } = await resolveTargets(request ?? {});
        // 幂等：只处理状态真的要变的条目，`count` 报的是"这次改了几条"。
        const targets = metas.filter((meta) => (meta.archived === true) !== archived);
        if (!dryRun) {
          for (const meta of targets) {
            await store.archive(meta.id, archived);
            processed.push(meta.id);
          }
        }
        return {
          ok: true,
          contract: CONTRACT,
          dryRun,
          archived,
          ...impactOf(targets),
          unknown,
        };
      } catch (error) {
        return failureOf(error, {
          dryRun,
          archived,
          processed,
          count: processed.length,
          ids: processed,
        });
      }
    },

    /**
     * 级联清理：默认移入回收站（ADR 0002），`purge` 才是硬删。
     * @param {any} [request] `{ ids?, projectId?, dryRun? }`
     * @returns {Promise<any>}
     */
    async remove(request = {}) {
      const dryRun = request?.dryRun === true;
      const invalid = validateWriteRequest(request);
      if (invalid !== null) return invalid;
      if (!hasSelector(request ?? {}))
        return failure("artifacts/invalid", "remove needs ids or projectId");
      /** @type {string[]} */
      const processed = [];
      try {
        const { metas, unknown } = await resolveTargets(request ?? {});
        if (!dryRun) {
          for (const meta of metas) {
            if (await store.remove(meta.id)) processed.push(meta.id);
            else unknown.push(meta.id);
          }
        }
        return {
          ok: true,
          contract: CONTRACT,
          dryRun,
          restorable: true,
          trashRoot: store.trashRoot,
          ...impactOf(metas),
          removed: dryRun ? [] : processed,
          unknown,
        };
      } catch (error) {
        return failureOf(error, {
          dryRun,
          restorable: true,
          trashRoot: store.trashRoot,
          processed,
          count: processed.length,
          ids: processed,
        });
      }
    },

    /**
     * 从回收站恢复。`ids` 可以是工件 id，也可以是 `trash()` 返回的 `trashKey`；
     * 找到了但恢复不了（目标 id 已被占用 / 旧 meta 的 id 不安全）会进 `unknown`，不静默丢字节。
     * @param {any} [request] `{ ids, dryRun? }`
     * @returns {Promise<any>}
     */
    async restore(request = {}) {
      const dryRun = request?.dryRun === true;
      const invalid = validateWriteRequest(request);
      if (invalid !== null) return invalid;
      const tokens = idsOf(request?.ids);
      if (tokens.length === 0) return failure("artifacts/invalid", "restore needs ids");
      /** @type {string[]} */
      const processed = [];
      try {
        const trash = await store.listTrash();
        const byKey = new Map(trash.map((row) => [row.trashKey, row]));
        const byId = new Map(trash.map((row) => [row.id, row]));
        /** @type {Array<{ token: string, entry: any }>} */
        const matched = [];
        /** @type {string[]} */
        const unknown = [];
        for (const token of tokens) {
          const entry = byKey.get(token) ?? byId.get(token);
          if (entry === undefined) unknown.push(token);
          else matched.push({ token, entry });
        }
        if (!dryRun) {
          for (const item of matched) {
            if (await store.restore(item.entry.trashKey)) processed.push(item.entry.trashKey);
            else unknown.push(item.token);
          }
        }
        return {
          ok: true,
          contract: CONTRACT,
          dryRun,
          ...impactOf(matched.map((item) => item.entry)),
          ids: tokens,
          restored: dryRun ? [] : processed,
          unknown,
        };
      } catch (error) {
        return failureOf(error, { dryRun, processed, count: processed.length, ids: processed });
      }
    },

    /**
     * 回收站清单（ADR 0002 要求"能查看"）。行里的 `trashKey` 是权威键（目录名）。
     * @returns {Promise<any>}
     */
    async trash() {
      try {
        const rows = await store.listTrash();
        return {
          ok: true,
          contract: CONTRACT,
          artifacts: rows.map((meta) => ({
            ...publicArtifact(meta, routePrefix),
            trashKey: meta.trashKey,
            trashedAt: meta.trashedAt,
          })),
          summary: summarizeArtifacts(rows),
        };
      } catch (error) {
        return failureOf(error);
      }
    },

    /**
     * 硬删：只清回收站里的条目（彻底删除，不可恢复）。`ids` 同样接受 id 或 trashKey。
     * @param {any} [request] `{ ids?, projectId?, dryRun? }`
     * @returns {Promise<any>}
     */
    async purge(request = {}) {
      const dryRun = request?.dryRun === true;
      const invalid = validateWriteRequest(request);
      if (invalid !== null) return invalid;
      if (!hasSelector(request ?? {}))
        return failure("artifacts/invalid", "purge needs ids or projectId");
      /** @type {string[]} */
      const processed = [];
      try {
        const trash = await store.listTrash();
        const tokens = idsOf(request?.ids);
        /** @type {Array<{ token: string, entry: any }>} */
        const matched = [];
        /** @type {string[]} */
        const unknown = [];
        if (tokens.length > 0) {
          const byKey = new Map(trash.map((row) => [row.trashKey, row]));
          const byId = new Map(trash.map((row) => [row.id, row]));
          for (const token of tokens) {
            const entry = byKey.get(token) ?? byId.get(token);
            if (entry === undefined) unknown.push(token);
            else matched.push({ token, entry });
          }
        } else {
          const projectId = textOrNull(request?.projectId);
          for (const entry of trash) {
            if (textOrNull(entry.projectId) === projectId)
              matched.push({ token: entry.trashKey, entry });
          }
        }
        if (!dryRun) {
          for (const item of matched) {
            if (await store.purge(item.entry.trashKey)) processed.push(item.entry.trashKey);
            else unknown.push(item.token);
          }
        }
        return {
          ok: true,
          contract: CONTRACT,
          dryRun,
          restorable: false,
          ...impactOf(matched.map((item) => item.entry)),
          purged: dryRun ? [] : processed,
          unknown,
        };
      } catch (error) {
        return failureOf(error, { dryRun, restorable: false, processed, count: processed.length });
      }
    },
  };
}
