// @ts-check
// 测试夹具：造一个「像宿主」的最小替身 + 临时数据根。
// 被 operations.test.js / recovery.test.js 共用（不是 *.test.js，node --test 不会单独跑它）。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
    },
    unarchiveSession: async () => {
      state.archived = false;
    },
    pinSession: async () => {
      if (failPin) throw new Error("pinSession refused");
      state.pinned = true;
    },
    unpinSession: async () => {
      state.pinned = false;
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
