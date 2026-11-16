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

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
});

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
   * @param {{ dataRoot: string, logger?: { warn: (...args: unknown[]) => void } }} options
   */
  constructor(options) {
    if (!options || typeof options.dataRoot !== "string" || options.dataRoot === "") {
      throw new CaseStoreError("no-data-root", "dataRoot 未配置：casefile 需要可注入的数据根目录");
    }
    this.dataRoot = options.dataRoot;
    this.logger = options.logger ?? { warn: () => {} };
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
   * 原子写 JSON（先写临时文件再 rename）。
   * @param {string} file
   * @param {Record<string, any>} value
   */
  writeJson(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
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
   * @returns {{ evidence: any[], claims: any[], features: any[], unknowns: any[] }}
   */
  readAll(projectId) {
    return {
      evidence: this.readRecords(projectId, "evidence"),
      claims: this.readRecords(projectId, "claims"),
      features: this.readRecords(projectId, "features"),
      unknowns: this.readRecords(projectId, "unknowns"),
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
   * @param {string} projectId
   */
  touch(projectId) {
    const file = join(this.projectDir(projectId), "project.json");
    const project = this.readJson(file);
    if (!project) return;
    this.writeJson(file, { ...project, updatedAt: nowIso() });
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
