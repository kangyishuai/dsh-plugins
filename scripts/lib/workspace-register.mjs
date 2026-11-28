// @ts-check
// `--deep` 桌面冒烟的测试工作区注册核心：把 `--workspace` 目录写进宿主的
// `<DSH_HOME>/storages/workspace.json`。桌面添加工作区走的是 Electron 原生目录选择器，
// CDP 驱动不了，这是 `pnpm gate:session-rewind --deep` 唯一需要改宿主注册表的前置。
//
// 安全边界（helper 会直接改宿主的持久化文件，所以宁可拒绝也不猜）：
// - 只复用/追加 `tables.workspaces` 里的一条记录；已有文件的其它字段原样保留，
//   结构不认识就直接拒绝（不迁移、不 `rm`、不重建），符合 AGENTS.md 硬性约定 1；
// - 已有文件先备份 `<file>.bak-<ts>`，再用同目录临时文件 + `rename` 原子写；
// - 路径按 **realpath** 去重与存储：macOS `/tmp` 是 `/private/tmp` 的软链，宿主按真实路径
//   绑定会话 cwd，注册软链路径会让「新建会话」attach 失败（见 docs/testing/session-rewind.md §2.6.1）；
// - 默认拒绝 `$HOME/.dsh` 及其子目录（真实桌面版的数据根），必须显式 `--allow-live`；
// - 支持 dry-run：只算不写。
//
// 宿主在启动时把 workspace.json 读进内存，运行中可能再写回；所以注册要在桌面版
// 启动前完成，或注册后重启桌面版（文档里写明）。
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** 宿主 workspace 存储的 `unit` 字段；缺了存储校验不过、工作区不会被采纳。 */
export const WORKSPACE_UNIT = Object.freeze({ name: "workspace", version: 2 });

/**
 * @typedef {{
 *   path: string,
 *   title: string,
 *   sessionIds: string[],
 *   createdAt: string,
 *   updatedAt: string,
 * }} WorkspaceEntry
 *
 * @typedef {{
 *   unit: { name: string, version: number },
 *   global: {
 *     initialized: boolean,
 *     workspaceIds: string[],
 *     archivedSessionIds: string[],
 *     pinnedSessionIds: string[],
 *     defaultWorkspaceId: string | null,
 *   },
 *   tables: { workspaces: Record<string, WorkspaceEntry> },
 * }} WorkspaceStore
 *
 * @typedef {{
 *   registered: boolean,
 *   alreadyExisted: boolean,
 *   id: string,
 *   path: string,
 *   title: string,
 *   home: string,
 *   storeFile: string,
 *   backupFile: string | null,
 *   dryRun: boolean,
 *   written: boolean,
 * }} RegisterSummary
 */

/** helper 的拒绝原因：`safety` 是安全闸（CLI 退出码 2），其它是参数/状态问题（退出码 1）。 */
export class WorkspaceRegisterError extends Error {
  /**
   * @param {string} message
   * @param {"usage" | "safety" | "state"} code
   */
  constructor(message, code) {
    super(message);
    this.name = "WorkspaceRegisterError";
    /** @type {"usage" | "safety" | "state"} */
    this.code = code;
  }
}

/**
 * 宿主认可的 workspace 存储骨架。`pnpm new` / web 冒烟脚本里手写的也是这一份格式
 * （见 scripts/smoke-advisor.mjs 的 «只放一个工作区» 段）。
 * @returns {WorkspaceStore}
 */
export function emptyWorkspaceStore() {
  return {
    unit: { ...WORKSPACE_UNIT },
    global: {
      initialized: true,
      workspaceIds: [],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: null,
    },
    tables: { workspaces: {} },
  };
}

/**
 * 能解析符号链接就解析，解析不到（路径还不存在）就退回绝对路径。
 * @param {string} path
 * @returns {string}
 */
export function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * `--path` 规范化：必须已存在且是目录，返回 **realpath**（宿主按真实路径匹配工作区）。
 * @param {string} target
 * @returns {string}
 */
export function normalizeWorkspacePath(target) {
  let real;
  try {
    real = realpathSync(target);
  } catch {
    throw new WorkspaceRegisterError(
      `--path 不存在：${target}（helper 不会替你建目录；先 mkdir 出专用测试工作区）`,
      "usage",
    );
  }
  if (!statSync(real).isDirectory()) {
    throw new WorkspaceRegisterError(`--path 不是目录：${target}`, "usage");
  }
  return real;
}

/**
 * `--home` 是否指向真实桌面版的数据根（`$HOME/.dsh` 及其子目录，含 `profiles/*`）。
 * 用 realpath 比较：`$HOME` 或 home 参数本身可能是软链。
 * @param {string} home
 * @param {string} [envHome] 用户主目录；测试可注入，CLI 默认 `os.homedir()`（遵循 `$HOME`）
 * @returns {boolean}
 */
export function isLiveHome(home, envHome = homedir()) {
  const liveRoot = canonicalPath(join(envHome, ".dsh"));
  const target = canonicalPath(home);
  return target === liveRoot || target.startsWith(`${liveRoot}${sep}`);
}

/**
 * 读取并校验已有存储；文件不存在时返回空骨架。
 * @param {string} file
 * @returns {WorkspaceStore}
 */
export function readWorkspaceStore(file) {
  if (!existsSync(file)) return emptyWorkspaceStore();
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new WorkspaceRegisterError(
      `${file} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）：拒绝改写，先修好它或换一个 DSH_HOME`,
      "state",
    );
  }
  return validateWorkspaceStore(parsed, file);
}

/**
 * 只认宿主已知的结构：缺字段可以补，结构不认识就拒绝（避免把别的版本/别的文件写坏）。
 * @param {any} parsed
 * @param {string} file
 * @returns {WorkspaceStore}
 */
function validateWorkspaceStore(parsed, file) {
  /** @param {string} why @returns {never} */
  const refuse = (why) => {
    throw new WorkspaceRegisterError(
      `${file} 的结构不是已知的宿主 workspace 存储（${why}）：拒绝改写。请用桌面 UI 注册，或换一个 DSH_HOME`,
      "state",
    );
  };
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    refuse("根不是对象");
  }
  const store = /** @type {any} */ (parsed);
  if (
    store.global === undefined ||
    store.global === null ||
    typeof store.global !== "object" ||
    Array.isArray(store.global)
  ) {
    refuse("global 不是对象");
  }
  if (!Array.isArray(store.global.workspaceIds)) refuse("global.workspaceIds 不是数组");
  if (
    store.tables === undefined ||
    store.tables === null ||
    typeof store.tables !== "object" ||
    Array.isArray(store.tables)
  ) {
    refuse("tables 不是对象");
  }
  if (store.tables.workspaces === undefined) store.tables.workspaces = {};
  if (
    store.tables.workspaces === null ||
    typeof store.tables.workspaces !== "object" ||
    Array.isArray(store.tables.workspaces)
  ) {
    refuse("tables.workspaces 不是对象");
  }
  if (store.unit === undefined) store.unit = { ...WORKSPACE_UNIT };
  return /** @type {WorkspaceStore} */ (store);
}

/**
 * 按 realpath 查已有工作区（宿主可能把同一个目录按软链写法存过，比较前统一规范化）。
 * @param {WorkspaceStore} store
 * @param {string} normalizedPath
 * @returns {{ id: string, entry: WorkspaceEntry } | undefined}
 */
export function findWorkspaceByPath(store, normalizedPath) {
  for (const [id, entry] of Object.entries(store.tables.workspaces)) {
    if (entry === null || typeof entry !== "object" || typeof entry.path !== "string") continue;
    if (canonicalPath(entry.path) === normalizedPath) return { id, entry };
  }
  return undefined;
}

/**
 * 把已有存储备份成 `<file>.bak-<ts>`（同一毫秒多次调用时加序号，保证不覆盖旧备份）。
 * @param {string} file
 * @param {Date} [now]
 * @returns {string} 备份文件路径
 */
export function backupWorkspaceFile(file, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  let backup = `${file}.bak-${stamp}`;
  for (let index = 1; existsSync(backup); index += 1) backup = `${file}.bak-${stamp}-${index}`;
  copyFileSync(file, backup);
  return backup;
}

/**
 * 原子写：同目录临时文件写完再 rename（跨目录 rename 不原子，所以临时文件必须同目录）。
 * @param {string} file
 * @param {WorkspaceStore} store
 */
export function writeWorkspaceStoreAtomic(file, store) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * 注册一个测试工作区：幂等（同一 realpath 只登记一次）、默认拒绝 live home、
 * 已有文件先备份、原子写、只动工作区这一条记录。已有文件里的其它字段原样保留。
 * @param {{
 *   home: string,
 *   path: string,
 *   title?: string,
 *   allowLive?: boolean,
 *   dryRun?: boolean,
 *   now?: Date,
 *   id?: string,
 *   envHome?: string,
 * }} options
 * @returns {RegisterSummary}
 */
export function registerTestWorkspace(options) {
  const {
    home,
    path: targetPath,
    title: rawTitle,
    allowLive = false,
    dryRun = false,
    now = new Date(),
    id: explicitId,
    envHome = homedir(),
  } = options;

  // 先解析 home（要求已存在）再做安全闸：拒绝时不会读/写任何文件。
  let homeReal;
  try {
    homeReal = realpathSync(home);
  } catch {
    throw new WorkspaceRegisterError(
      `--home 不存在：${home}（先建好测试用的 DSH_HOME，或用桌面版真实数据根并加 --allow-live）`,
      "usage",
    );
  }
  if (!statSync(homeReal).isDirectory()) {
    throw new WorkspaceRegisterError(`--home 不是目录：${home}`, "usage");
  }
  if (!allowLive && isLiveHome(homeReal, envHome)) {
    throw new WorkspaceRegisterError(
      `--home 指向真实桌面版的数据根（${homeReal}，位于 ${join(envHome, ".dsh")} 下）：` +
        "测试工作区不应该写进 live home。冒烟/CI 请用临时 DSH_HOME；" +
        "只有确实要在真实桌面版上注册时才加 --allow-live",
      "safety",
    );
  }

  const target = normalizeWorkspacePath(targetPath);
  const requestedTitle = typeof rawTitle === "string" ? rawTitle.trim() : "";
  const title = requestedTitle === "" ? basename(target) : requestedTitle;
  const storeFile = join(homeReal, "storages", "workspace.json");

  let targetStat;
  try {
    targetStat = lstatSync(storeFile);
  } catch {
    targetStat = undefined;
  }
  if (targetStat?.isSymbolicLink()) {
    throw new WorkspaceRegisterError(
      `${storeFile} 是符号链接：拒绝原地改写（原子写会把链接替换成普通文件）`,
      "state",
    );
  }

  const store = readWorkspaceStore(storeFile);
  const existing = findWorkspaceByPath(store, target);
  if (existing) {
    return {
      registered: true,
      alreadyExisted: true,
      id: existing.id,
      path: target,
      title: typeof existing.entry.title === "string" ? existing.entry.title : title,
      home: homeReal,
      storeFile,
      backupFile: null,
      dryRun,
      written: false,
    };
  }

  const id = explicitId ?? randomUUID();
  if (Object.hasOwn(store.tables.workspaces, id)) {
    throw new WorkspaceRegisterError(
      `工作区 id ${id} 已存在于 ${storeFile}：拒绝覆盖已有记录`,
      "state",
    );
  }
  const iso = now.toISOString();
  store.tables.workspaces[id] = {
    path: target,
    title,
    sessionIds: [],
    createdAt: iso,
    updatedAt: iso,
  };
  store.global.workspaceIds.push(id);
  // 空存储（刚初始化的测试 home）默认工作区留空会没有「默认工作区」，顺手设成这一条；
  // 已有默认工作区时绝不替换。
  if (!store.global.defaultWorkspaceId) store.global.defaultWorkspaceId = id;

  if (dryRun) {
    return {
      registered: true,
      alreadyExisted: false,
      id,
      path: target,
      title,
      home: homeReal,
      storeFile,
      backupFile: null,
      dryRun: true,
      written: false,
    };
  }

  const backupFile = existsSync(storeFile) ? backupWorkspaceFile(storeFile, now) : null;
  writeWorkspaceStoreAtomic(storeFile, store);
  return {
    registered: true,
    alreadyExisted: false,
    id,
    path: target,
    title,
    home: homeReal,
    storeFile,
    backupFile,
    dryRun: false,
    written: true,
  };
}
