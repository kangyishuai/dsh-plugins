// @ts-check
// 测试夹具：造一个「像宿主」的最小替身 + 临时数据根。
// 被 operations.test.js / recovery.test.js 共用（不是 *.test.js，node --test 不会单独跑它）。
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperations } from "../lib/operations.js";
import { encodeSegment, projectKey } from "../lib/paths.js";

/** 默认会话 id（夹具只造这一个「主会话」）。 */
export const SESSION_ID = "session-abc";

/**
 * 造一个「像宿主」的最小替身。
 * @param {{ live?: boolean, createDir?: boolean, children?: { id: string, title: string | null }[], gate?: () => Promise<void>,
 *   failAttach?: boolean, failPin?: boolean }} [options]
 */
export async function fixture(options = {}) {
  const {
    live = false,
    createDir = true,
    children = [],
    gate,
    failAttach = false,
    failPin = false,
  } = options;
  const dataRoot = await mkdtemp(join(tmpdir(), "dsh-sdel-ops-"));
  const sessionId = SESSION_ID;
  const cwd = "/w";
  const sessionDir = join(dataRoot, "sessions", projectKey(cwd), encodeSegment(sessionId));
  if (createDir) {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.v4.jsonl.zstd"), "x".repeat(4096));
  }

  const state = {
    archived: false,
    pinned: false,
    sessionIds: new Set([sessionId]),
    flushed: 0,
    stopped: 0,
    detached: 0,
  };

  /**
   * 让假宿主的 pin 写入 `storages/workspace.json`（文件不存在时静默跳过）。
   * 宿主行为见 docs/runtime/0.2.1-rc.5 §6：**归档会在同一次写里清掉 pin**，
   * 所以假宿主也必须照做，否则「置顶快照取在归档之前」这类顺序 bug 会被单测放绿。
   * @param {boolean} pinned
   */
  async function writePinnedFlag(pinned) {
    const file = join(dataRoot, "storages", "workspace.json");
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return; // 没有 storages/workspace.json 就没什么可写（读侧会按「未知」降级）
    }
    const global = parsed.global ?? {};
    /** @type {string[]} */
    const current = Array.isArray(global.pinnedSessionIds)
      ? global.pinnedSessionIds.map(String)
      : [];
    const without = current.filter((/** @type {string} */ id) => id !== sessionId);
    global.pinnedSessionIds = pinned ? [...new Set([...without, sessionId])] : without;
    parsed.global = global;
    await writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
  }

  const workspace = {
    list: () => [
      {
        id: "ws1",
        sessionIds: [...state.sessionIds],
        detachSession: async (/** @type {string} */ id) => {
          state.sessionIds.delete(id);
          state.detached += 1;
        },
        attachSession: async (/** @type {string} */ id) => {
          if (failAttach) throw new Error("attachSession refused");
          state.sessionIds.add(id);
        },
      },
    ],
    archiveSession: async () => {
      // 测试并发时不靠「谁先跑完」猜时序：给一个显式挂起点，
      // 让第一个操作确定地停在 in-flight 状态里（之前这条断言在负载高时会假失败）。
      if (typeof gate === "function") await gate();
      state.archived = true;
      // 宿主真实行为：归档同一次写里清 pin（docs/runtime 0.2.1-rc.5 §6）。
      state.pinned = false;
      await writePinnedFlag(false);
    },
    unarchiveSession: async () => {
      state.archived = false;
    },
    pinSession: async () => {
      if (failPin) throw new Error("pinSession refused");
      state.pinned = true;
      await writePinnedFlag(true);
    },
    unpinSession: async () => {
      state.pinned = false;
      await writePinnedFlag(false);
    },
  };

  const persistence = {
    stat: async (/** @type {string} */ id) => {
      if (id === sessionId) {
        return { header: { id: sessionId, title: "hello", cwd }, sizeBytes: 4096 };
      }
      const child = children.find((/** @type {any} */ item) => item.id === id);
      if (child) {
        return {
          header: { id, title: child.title, cwd, parentSession: sessionId },
          sizeBytes: 128,
        };
      }
      return undefined;
    },
    list: async () => [
      { id: sessionId, header: { id: sessionId, title: "hello", cwd } },
      ...children.map((/** @type {any} */ child) => ({
        id: child.id,
        header: { id: child.id, title: child.title, cwd, parentSession: sessionId },
      })),
    ],
  };
  const liveEntry = live ? { header: { id: sessionId, cwd } } : undefined;
  const sessions = {
    get: (/** @type {string} */ id) => (id === sessionId ? liveEntry : undefined),
    flush: async () => {
      state.flushed += 1;
    },
  };

  /** @type {Record<string, any>} */
  const services = { sessionPersistence: persistence, sessions, workspaceRegistry: workspace };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (/** @type {string} */ name) => services[name],
    parallel: async () => {
      state.stopped += 1;
    },
    waterfall: async () => [{ kind: "subagent", items: [{ id: "child-1", label: "子代理一" }] }],
  };

  const childDirs = [];
  for (const child of children) {
    const dir = join(dataRoot, "sessions", projectKey(cwd), encodeSegment(child.id));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session.v4.jsonl.zstd"), "y".repeat(64));
    childDirs.push(dir);
  }

  const ops = createOperations({ ctx, dataRoot, logger: ctx.logger });
  return { dataRoot, sessionId, sessionDir, childDirs, state, ops, ctx };
}

/**
 * 写一份 `storages/workspace.json`（置顶集合没有公开读接口，插件只能读这份文件）。
 * @param {string} dataRoot
 * @param {{ pinned?: string[], archived?: string[], workspaces?: Record<string, string[]> }} [input]
 */
export async function seedWorkspaceFile(dataRoot, input = {}) {
  const dir = join(dataRoot, "storages");
  await mkdir(dir, { recursive: true });
  /** @type {Record<string, unknown>} */
  const tables = {};
  for (const [id, sessionIds] of Object.entries(input.workspaces ?? {})) {
    tables[id] = { id, sessionIds };
  }
  await writeFile(
    join(dir, "workspace.json"),
    JSON.stringify(
      {
        global: {
          archivedSessionIds: input.archived ?? [],
          pinnedSessionIds: input.pinned ?? [],
        },
        tables: workspaceTables(tables),
      },
      null,
      2,
    ),
    "utf8",
  );
}

/**
 * @param {Record<string, unknown>} tables
 * @returns {Record<string, unknown>}
 */
function workspaceTables(tables) {
  return { workspaces: tables };
}
