// @ts-check
// core/store.js：项目文件的读写、版本守卫、审计。纯 Node，可单测。
//
// 存储布局（spec/02-architecture.md §3.2）：
//   <dataRoot>/projects/<id>/{project.json, evidence.jsonl, claims.jsonl,
//                            features.jsonl, unknowns.jsonl, audit.jsonl}
//
// 硬规则：
//   - 每个 JSON 文件带 version；读到更高版本 → 抛 readOnlyNewer，不静默改；
//   - 坏文件改名 `.broken` 并告警，不删除；
//   - JSONL append-only，修改用新记录 + supersedes（M0 先只追加）；
//   - 所有路径从 dataRoot 派生，不写死 ~/.dsh（可在临时目录里测）。

import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  CasefileInputError,
  ID_RE,
  normalizeProjectInput,
  nowIso,
  SCHEMA_VERSION,
  slugify,
} from "./model.js";

/** 存储错误：带稳定 code。 */
export class CaseStoreError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "CaseStoreError";
    this.code = code;
  }
}

/** 每个项目的 JSONL 文件表。 */
export const RECORD_FILES = /** @type {const} */ ({
  evidence: "evidence.jsonl",
  claims: "claims.jsonl",
  features: "features.jsonl",
  unknowns: "unknowns.jsonl",
  obligations: "obligations.jsonl",
  checks: "checks.jsonl",
  builds: "builds.jsonl",
  verifications: "verifications.jsonl",
  attestations: "attestations.jsonl",
});

/** 回收站条目名：`<ISO 时间戳（: . 换成 -）>-<projectId>`。只认这个形状，别的条目保留不删。 */
const TRASH_ENTRY_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-([a-z0-9][a-z0-9-]{0,63})$/u;

/** 归档单个产物的默认体积上限（64 MiB）：避免把整段录屏/大 HAR 读进主进程内存。 */
export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/**
 * 递归统计目录的文件数与字节数（读不了的文件跳过，不猜）。
 * @param {string} dir
 * @returns {{ bytes: number, files: number }}
 */
function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  /** @type {import("node:fs").Dirent[]} */
  let children = [];
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of children) {
    const path = `${dir}/${entry.name}`;
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) {
        const nested = dirStats(path);
        bytes += nested.bytes;
        files += nested.files;
      } else if (stat.isFile()) {
        bytes += stat.size;
        files += 1;
      }
    } catch {
      // 读不了的条目跳过：口径是"已知文件的大小"，不假装统计完整。
    }
  }
  return { bytes, files };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 项目文件存储。
 */
export class CaseStore {
  /**
   * @param {{
   *   dataRoot: string,
   *   logger?: { warn: (...args: unknown[]) => void },
   *   maxArtifactBytes?: number,
   * }} options
   */
  constructor(options) {
    if (!options || typeof options.dataRoot !== "string" || options.dataRoot === "") {
      throw new CaseStoreError("no-data-root", "dataRoot 未配置：casefile 需要可注入的数据根目录");
    }
    this.dataRoot = options.dataRoot;
    this.logger = options.logger ?? { warn: () => {} };
    const configuredMaxArtifactBytes = options.maxArtifactBytes;
    /** @type {number} */
    this.maxArtifactBytes =
      typeof configuredMaxArtifactBytes === "number" && configuredMaxArtifactBytes > 0
        ? configuredMaxArtifactBytes
        : DEFAULT_MAX_ARTIFACT_BYTES;
    /** 进程内串行化用的 promise 链（按文件路径分键，单进程即可覆盖绝大部分并发）。 @type {Map<string, Promise<void>>} */
    this.locks = new Map();
    this.ensureRoot();
  }

  /** @returns {string} */
  get rootDir() {
    return this.dataRoot;
  }

  /** 创建数据根与 projects 目录。 */
  ensureRoot() {
    mkdirSync(join(this.dataRoot, "projects"), { recursive: true });
  }

  /**
   * 校验并返回项目目录。
   * @param {string} projectId
   * @returns {string}
   */
  projectDir(projectId) {
    if (!ID_RE.test(String(projectId ?? ""))) {
      throw new CaseStoreError("bad-project-id", `非法项目 id：${String(projectId)}`);
    }
    return join(this.dataRoot, "projects", projectId);
  }

  /**
   * 列出磁盘上的项目 id。
   * @returns {string[]}
   */
  listProjectIds() {
    const dir = join(this.dataRoot, "projects");
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  /**
   * 读一个 JSON 文件；坏文件改名 `.broken`，高版本抛错。
   * @param {string} file
   * @returns {Record<string, any> | null}
   */
  readJson(file) {
    if (!existsSync(file)) return null;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      const broken = `${file}.broken`;
      try {
        renameSync(file, broken);
      } catch {
        /* ignore */
      }
      this.logger.warn(`casefile: 坏文件已改名 ${broken}：${String(error)}`);
      return null;
    }
    if (!isRecord(parsed)) return null;
    const version = Number(parsed.version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new CaseStoreError(
        "read-only-newer",
        `项目文件版本 ${version} 高于本插件支持的 ${SCHEMA_VERSION}；请升级 casefile 后重试（文件保持只读）`,
      );
    }
    return parsed;
  }

  /**
   * 原子写 JSON（先写唯一临时文件再 rename）。
   * 临时名带 pid + 随机后缀：同一个文件被并发写时不会互相截断（AUD-CASEFILE-07）。
   * @param {string} file
   * @param {Record<string, any>} value
   */
  writeJson(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      renameSync(tmp, file);
    } catch (error) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
      throw error;
    }
  }

  /**
   * 进程内按 key 串行化：`prior.then(fn)` 保证同一个文件的读-改-写不会交错。
   * 只覆盖单进程；跨进程仍可能竞争，但至少临时文件唯一，不会写出半截 JSON。
   * @template T
   * @param {string} key
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  withLock(key, fn) {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const run = prior.then(() => fn());
    const settled = run.then(
      () => {},
      () => {},
    );
    this.locks.set(key, settled);
    settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  /**
   * 读-改-写一个 JSON 文件（在进程内锁里完成，避免丢失更新）。
   * 文件不存在时返回 null 且不创建。
   * `mutate` 可以是异步的：锁会一直持有到写盘完成，所以「读 → await → 写」不会交错。
   * 注意：node 的同步 IO 本身不可交错，锁覆盖的是**回调里含 await** 的情形；
   * 跨进程的竞争仍不覆盖（只靠唯一临时文件名保证不会写出半截 JSON）。
   * @param {string} file
   * @param {(current: Record<string, any>) => Record<string, any> | Promise<Record<string, any>>} mutate
   * @returns {Promise<Record<string, any> | null>}
   */
  updateJson(file, mutate) {
    return this.withLock(file, async () => {
      const current = this.readJson(file);
      if (current == null) return null;
      const next = (await mutate(current)) ?? current;
      this.writeJson(file, next);
      return next;
    });
  }

  /**
   * 追加一行 JSONL。
   * @param {string} projectId
   * @param {keyof typeof RECORD_FILES} name
   * @param {Record<string, any>} record
   */
  appendRecord(projectId, name, record) {
    const file = join(this.projectDir(projectId), RECORD_FILES[name]);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  }

  /**
   * 读一个 JSONL 文件（跳过空行与坏行）。
   * 同一 id 出现多次时**后者胜**：更新 = 追加同 id 的新记录（文件保持 append-only、可 diff）。
   * @param {string} projectId
   * @param {keyof typeof RECORD_FILES} name
   * @returns {Record<string, any>[]}
   */
  readRecords(projectId, name) {
    const file = join(this.projectDir(projectId), RECORD_FILES[name]);
    if (!existsSync(file)) return [];
    /** @type {Map<string, Record<string, any>>} */
    const byId = new Map();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (!isRecord(parsed)) continue;
        const key = typeof parsed.id === "string" ? parsed.id : `__anon_${byId.size}`;
        byId.set(key, parsed);
      } catch (error) {
        this.logger.warn(`casefile: ${file} 有坏行已跳过：${String(error)}`);
      }
    }
    return [...byId.values()];
  }

  /**
   * 读一个项目的全部记录。
   * @param {string} projectId
   * @returns {{
   *   evidence: any[], claims: any[], features: any[], unknowns: any[], obligations: any[],
   *   checks: any[], builds: any[], verifications: any[], attestations: any[],
   * }}
   */
  readAll(projectId) {
    return {
      evidence: this.readRecords(projectId, "evidence"),
      claims: this.readRecords(projectId, "claims"),
      features: this.readRecords(projectId, "features"),
      unknowns: this.readRecords(projectId, "unknowns"),
      obligations: this.readRecords(projectId, "obligations"),
      checks: this.readRecords(projectId, "checks"),
      builds: this.readRecords(projectId, "builds"),
      verifications: this.readRecords(projectId, "verifications"),
      attestations: this.readRecords(projectId, "attestations"),
    };
  }

  /**
   * 写审计（append-only）。
   * @param {string} projectId
   * @param {Record<string, any>} entry
   */
  audit(projectId, entry) {
    const file = join(this.projectDir(projectId), "audit.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ at: nowIso(), ...entry })}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }

  /**
   * 写数据根级审计（append-only）。
   * 用途：项目目录被移进回收站后就写不进项目内 audit.jsonl，必须在数据根留痕（ADR 0002 §4）。
   * @param {Record<string, any>} entry
   */
  auditRoot(entry) {
    const file = join(this.dataRoot, "audit.jsonl");
    writeFileSync(file, `${JSON.stringify({ at: nowIso(), ...entry })}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }

  /**
   * 读数据根级审计。
   * @returns {Record<string, any>[]}
   */
  readAuditRoot() {
    const file = join(this.dataRoot, "audit.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((row) => row !== null);
  }

  /**
   * 记「最近打开的项目」（跨会话/UI 共用；只用于提示，不代替会话指针）。
   * @param {string} projectId
   */
  markLastOpened(projectId) {
    const id = String(projectId ?? "");
    if (!ID_RE.test(id)) return;
    // 「最近打开」只用于缺 projectId 时的提示；数据根只读/磁盘写满时写不进去，
    // 不能因此让纯读动作（get/list）失败（复审 F6）。
    try {
      this.writeJson(join(this.dataRoot, "last-opened.json"), {
        version: 1,
        projectId: id,
        at: nowIso(),
      });
    } catch (error) {
      this.logger.warn(`casefile: 记「最近打开」失败（忽略，不影响本次读取）：${String(error)}`);
    }
  }

  /**
   * 读「最近打开的项目」id；文件不存在/读坏返回 null。
   * @returns {string | null}
   */
  lastOpenedProjectId() {
    const value = this.readJson(join(this.dataRoot, "last-opened.json"));
    const id = value?.projectId;
    return typeof id === "string" && ID_RE.test(id) ? id : null;
  }

  /**
   * 读审计。
   * @param {string} projectId
   * @returns {Record<string, any>[]}
   */
  readAudit(projectId) {
    const file = join(this.projectDir(projectId), "audit.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((row) => row !== null);
  }

  /**
   * 建项目（不覆盖已有）。
   * @param {Record<string, any>} input
   * @returns {Record<string, any>}
   */
  createProject(input) {
    const normalized = normalizeProjectInput(input);
    const dir = this.projectDir(normalized.id);
    if (existsSync(join(dir, "project.json"))) {
      throw new CaseStoreError("project-exists", `项目已存在：${normalized.id}`);
    }
    const now = nowIso();
    const project = {
      version: SCHEMA_VERSION,
      id: normalized.id,
      title: normalized.title,
      target: normalized.target,
      authTier: normalized.authTier,
      scope: normalized.scope,
      reaVersion: normalized.reaVersion,
      capabilityHash: normalized.capabilityHash,
      state: "investigating",
      createdAt: now,
      updatedAt: now,
    };
    mkdirSync(dir, { recursive: true });
    this.writeJson(join(dir, "project.json"), project);
    this.audit(project.id, {
      actor: "user",
      action: "project/create",
      target: project.id,
      detail: { title: project.title, authTier: project.authTier, scope: project.scope },
    });
    return project;
  }

  /**
   * 读项目；不存在返回 null。
   * @param {string} projectId
   * @returns {Record<string, any> | null}
   */
  getProject(projectId) {
    return this.readJson(join(this.projectDir(projectId), "project.json"));
  }

  /**
   * 更新项目（白名单字段）。
   * @param {string} projectId
   * @param {Record<string, any>} patch
   * @returns {Record<string, any>}
   */
  /**
   * 归档：状态改为 archived，文件保留。误建/待整理的项目用它收起来。
   * @param {string} projectId
   * @param {string} [reason]
   * @returns {Record<string, any>}
   */
  archiveProject(projectId, reason) {
    const project = this.getProject(projectId);
    if (!project) throw new CaseStoreError("project-not-found", `项目不存在：${projectId}`);
    const next = {
      ...project,
      state: "archived",
      archivedAt: new Date().toISOString(),
      archiveReason: reason == null ? "" : String(reason).slice(0, 500),
    };
    this.writeJson(join(this.projectDir(projectId), "project.json"), next);
    return next;
  }

  /** 回收站根目录。 @returns {string} */
  get trashRoot() {
    return join(this.dataRoot, "trash");
  }

  /**
   * 项目目录当前占用的文件数与字节数（drop 的影响面口径）。
   * @param {string} projectId
   * @returns {{ bytes: number, files: number }}
   */
  projectImpact(projectId) {
    return dirStats(this.projectDir(projectId));
  }

  /**
   * drop 的**预览**回收站路径（按当前时间生成的目录名）。
   * 只用于 dry-run 展示：实际 drop 会重新取时间戳，所以预览路径不是最终落点（F5）。
   * @param {string} projectId
   * @returns {string}
   */
  expectedTrashPath(projectId) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return join(this.trashRoot, `${stamp}-${projectId}`);
  }

  /**
   * 丢弃：把整个项目目录移进 `<dataRoot>/trash/`，可恢复。
   * 破坏性操作，必须显式 confirm（由 actions 层校验）；本方法只做搬迁。
   * @param {string} projectId
   * @returns {{ trashedTo: string, project: Record<string, any> }}
   */
  dropProject(projectId) {
    const project = this.getProject(projectId);
    if (!project) throw new CaseStoreError("project-not-found", `项目不存在：${projectId}`);
    mkdirSync(this.trashRoot, { recursive: true });
    const target = this.expectedTrashPath(projectId);
    renameSync(this.projectDir(projectId), target);
    return { trashedTo: target, project };
  }

  /**
   * 列回收站里**认识**的条目；来历不明的条目单独计数（不删、不猜）。
   * @returns {{ entries: Record<string, any>[], unknown: string[] }}
   */
  scanTrash() {
    /** @type {Record<string, any>[]} */
    const entries = [];
    /** @type {string[]} */
    const unknown = [];
    if (!existsSync(this.trashRoot)) return { entries, unknown };
    let children;
    try {
      children = readdirSync(this.trashRoot, { withFileTypes: true });
    } catch (error) {
      this.logger.warn(`casefile: 回收站不可读：${String(error)}`);
      return { entries, unknown };
    }
    for (const entry of children) {
      if (!entry.isDirectory()) {
        unknown.push(entry.name);
        continue;
      }
      const match = TRASH_ENTRY_RE.exec(entry.name);
      if (!match) {
        unknown.push(entry.name);
        this.logger.warn(`casefile: 回收站里有不认识的条目，已保留：${entry.name}`);
        continue;
      }
      const path = join(this.trashRoot, entry.name);
      const stats = dirStats(path);
      // project.json 可能读不了（坏 JSON / 版本高于本插件）：条目仍然要列出来
      // （它还在 trash 里、还能手工处理），元数据按「未知」降级，而不是让整张表报错（N2）。
      /** @type {Record<string, any> | null} */
      let project = null;
      let metadataUnreadable = false;
      try {
        project = this.readJson(join(path, "project.json"));
      } catch (error) {
        metadataUnreadable = true;
        this.logger.warn(
          `casefile: 回收站条目 ${entry.name} 的 project.json 读不了（${String(/** @type {any} */ (error)?.code ?? error)}），元数据按未知处理`,
        );
      }
      entries.push({
        name: entry.name,
        projectId: match[8],
        path,
        trashedAt: `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`,
        bytes: stats.bytes,
        files: stats.files,
        title: typeof project?.title === "string" ? project.title : null,
        state: typeof project?.state === "string" ? project.state : null,
        metadataUnreadable,
      });
    }
    entries.sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)));
    return { entries, unknown };
  }

  /**
   * 从回收站恢复一个条目。
   * @param {string} name 回收站条目名（不接受路径，防穿越）
   * @returns {{ project: Record<string, any>, restoredTo: string }}
   */
  restoreTrash(name) {
    const entry = String(name ?? "");
    const match = TRASH_ENTRY_RE.exec(entry);
    if (!match) {
      throw new CaseStoreError("invalid-input", `不是认识的回收站条目名：${entry || "(空)"}`);
    }
    const path = join(this.trashRoot, entry);
    if (!existsSync(path)) {
      throw new CaseStoreError("not-found", `回收站里没有这个条目：${entry}`);
    }
    const projectId = match[8];
    const projectDir = this.projectDir(projectId);
    if (existsSync(join(projectDir, "project.json"))) {
      throw new CaseStoreError(
        "project-exists",
        `项目 ${projectId} 现在已存在；先处理同名项目再恢复（不会覆盖现有数据）`,
      );
    }
    // 搬家前先校验条目里的 project.json（F3）：坏条目不能被「恢复」成 projects/ 下的孤儿。
    // 失败时什么都不搬，条目继续留在回收站（数据可救）。
    /** @type {Record<string, any> | null} */
    let manifest = null;
    try {
      manifest = this.readJson(join(path, "project.json"));
    } catch (error) {
      throw new CaseStoreError(
        "not-found",
        `回收站条目不可恢复（${String(/** @type {any} */ (error)?.code ?? error)}），条目仍保留在回收站：${entry}`,
      );
    }
    if (!manifest) {
      throw new CaseStoreError(
        "not-found",
        `回收站条目缺少可读的 project.json，条目仍保留在回收站：${entry}`,
      );
    }
    const manifestId = String(manifest.id ?? "");
    if (manifestId !== projectId || !ID_RE.test(manifestId)) {
      throw new CaseStoreError(
        "invalid-input",
        `回收站条目的 project.json 与条目名不一致（${manifestId || "空"} ≠ ${projectId}），未移动：${entry}`,
      );
    }
    mkdirSync(join(this.dataRoot, "projects"), { recursive: true });
    renameSync(path, projectDir);
    /** @type {Record<string, any> | null} */
    let project = null;
    try {
      project = this.getProject(projectId);
    } catch {
      project = null;
    }
    if (!project) {
      // 搬家后仍读不到（例如并发把文件写坏）：回滚，别让项目在 projects/ 里变成幽灵。
      try {
        renameSync(projectDir, path);
      } catch {
        this.logger.warn(`casefile: 恢复回滚失败，项目留在 projects/${projectId}`);
      }
      throw new CaseStoreError("project-not-found", `恢复后读不到项目，已回滚到回收站：${entry}`);
    }
    return { project, restoredTo: projectDir };
  }

  /**
   * 清空回收站里认识的条目（显式硬删；来历不明的条目保留）。
   * @param {string[] | undefined} names 只清这些条目；省略 = 全部认识的条目
   * @returns {{ purged: number, bytes: number, names: string[], skipped: number }}
   */
  purgeTrash(names) {
    const { entries, unknown } = this.scanTrash();
    /** @type {Record<string, any>[]} */
    let selected = entries;
    if (names != null) {
      const wanted = new Set(names.map(String));
      selected = entries.filter((entry) => wanted.has(entry.name));
      const found = new Set(selected.map((entry) => entry.name));
      const missing = [...wanted].filter((name) => !found.has(name));
      if (missing.length > 0) {
        throw new CaseStoreError("not-found", `回收站里没有这些条目：${missing.join("、")}`);
      }
    }
    let bytes = 0;
    /** @type {string[]} */
    const purgedNames = [];
    for (const entry of selected) {
      bytes += Number(entry.bytes) || 0;
      rmSync(entry.path, { recursive: true, force: false });
      purgedNames.push(entry.name);
    }
    return {
      purged: purgedNames.length,
      bytes,
      names: purgedNames,
      skipped: unknown.length,
    };
  }

  /**
   * 局部更新项目字段。
   * @param {string} projectId
   * @param {Record<string, any>} patch
   * @returns {Record<string, any>}
   */
  updateProject(projectId, patch) {
    const project = this.getProject(projectId);
    if (!project) throw new CaseStoreError("project-not-found", `项目不存在：${projectId}`);
    const next = { ...project };
    if (patch.title != null) next.title = String(patch.title).slice(0, 200);
    if (patch.authTier != null) {
      if (!["owned", "authorized", "research"].includes(String(patch.authTier))) {
        throw new CasefileInputError("invalid-input", `非法授权档：${patch.authTier}`);
      }
      next.authTier = String(patch.authTier);
    }
    if (patch.scope != null) {
      if (!["all", "selected"].includes(String(patch.scope))) {
        throw new CasefileInputError("invalid-input", `非法范围：${patch.scope}`);
      }
      next.scope = String(patch.scope);
    }
    if (patch.state != null) next.state = String(patch.state).slice(0, 32);
    if (patch.reaVersion != null) next.reaVersion = String(patch.reaVersion).slice(0, 64);
    if (patch.autonomy != null && typeof patch.autonomy === "object") {
      next.autonomy = {
        level: String(patch.autonomy.level ?? "L2").slice(0, 4),
        unlockedAt: patch.autonomy.unlockedAt ?? null,
        budget: patch.autonomy.budget ?? null,
      };
    }
    if (patch.capabilityHash != null)
      next.capabilityHash = String(patch.capabilityHash).slice(0, 128);
    next.updatedAt = nowIso();
    this.writeJson(join(this.projectDir(projectId), "project.json"), next);
    this.audit(projectId, {
      actor: "user",
      action: "project/update",
      target: projectId,
      detail: { patch: Object.keys(patch) },
    });
    return next;
  }

  /**
   * 只更新 updatedAt，不写审计（记录追加时用）。
   * 走 updateJson 的进程内锁：连续的 add 不会互相覆盖 project.json（AUD-CASEFILE-07）。
   * @param {string} projectId
   * @returns {Promise<Record<string, any> | null>}
   */
  touch(projectId) {
    const file = join(this.projectDir(projectId), "project.json");
    return this.updateJson(file, (project) => ({ ...project, updatedAt: nowIso() }));
  }

  /**
   * 由标题推导一个未被占用的 id（`foo`、`foo-2`…）。
   * @param {string} title
   * @returns {string}
   */
  uniqueProjectId(title) {
    const base = slugify(title);
    let candidate = base;
    let n = 2;
    while (existsSync(join(this.dataRoot, "projects", candidate, "project.json"))) {
      candidate = `${base.slice(0, 56)}-${n}`;
      n += 1;
    }
    return candidate;
  }

  /**
   * 把外部采集产物归档进项目目录，返回归档后的元信息。
   * 目的：/tmp 里的产物会被清理，清了就无法复算 sha256，项目只能停在 investigating。
   * @param {string} projectId
   * @param {string} sourcePath 绝对路径的现成产物
   * @returns {{ sha256: string, bytes: number, file: string, originalName: string }}
   */
  archiveArtifact(projectId, sourcePath) {
    const source = String(sourcePath ?? "").trim();
    if (source === "" || !existsSync(source)) {
      throw new CasefileInputError("invalid-input", `产物不存在：${source || "(空)"}`);
    }
    const stat = statSync(source);
    if (!stat.isFile()) {
      throw new CasefileInputError("invalid-input", `不是普通文件：${source}`);
    }
    // 先做 stat 预检再读正文：几百 MB 的 HAR/录屏直接 readFileSync 会让主进程内存尖峰（AUD-CASEFILE-06）。
    if (stat.size > this.maxArtifactBytes) {
      throw new CasefileInputError(
        "artifact-too-large",
        `产物 ${source} 有 ${stat.size} 字节，超过上限 ${this.maxArtifactBytes} 字节；请先裁剪或显式调大 maxArtifactBytes`,
      );
    }
    const bytes = readFileSync(source);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const dir = join(this.projectDir(projectId), "artifacts");
    mkdirSync(dir, { recursive: true });
    const name = basename(source);
    const ext = extname(name);
    const file = join("artifacts", `${digest.slice(0, 16)}${ext}`);
    const target = join(this.projectDir(projectId), file);
    // 同样的内容只存一份：同一 sha256 已存在就直接复用
    if (!existsSync(target)) writeFileSync(target, bytes);
    return { sha256: digest, bytes: bytes.length, file, originalName: name };
  }

  /**
   * 记录一个 builder 子会话 id（数据根级，不分项目）。
   * builder 只该收到规格包，不该写账本——写类工具遇到它会拒绝。
   * @param {string} sessionId
   */
  recordBuilderSession(sessionId) {
    const id = String(sessionId ?? "").trim();
    if (id === "") return;
    const file = join(this.dataRoot, "builder-sessions.jsonl");
    appendFileSync(
      file,
      `${JSON.stringify({ sessionId: id, at: new Date().toISOString() })}\n`,
      "utf8",
    );
  }

  /**
   * 读 builder 会话 id 集合。
   * @returns {Set<string>}
   */
  listBuilderSessions() {
    const file = join(this.dataRoot, "builder-sessions.jsonl");
    if (!existsSync(file)) return new Set();
    /** @type {Set<string>} */
    const out = new Set();
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const text = line.trim();
      if (text === "") continue;
      try {
        const record = JSON.parse(text);
        if (typeof record?.sessionId === "string") out.add(record.sessionId);
      } catch {
        // 坏行跳过：这份索引是"宁可少拦"的辅助数据，坏了不影响主记录。
      }
    }
    return out;
  }

  /**
   * 项目列表（跳过坏项目并告警）。
   * @returns {Record<string, any>[]}
   */
  listProjects() {
    const projects = [];
    for (const id of this.listProjectIds()) {
      try {
        const project = this.getProject(id);
        if (project) projects.push(project);
      } catch (error) {
        this.logger.warn(`casefile: 项目 ${id} 读取失败已跳过：${String(error)}`);
      }
    }
    return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
}
