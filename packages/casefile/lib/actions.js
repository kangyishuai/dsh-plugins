// @ts-check
// actions.js：casefile 的全部业务动作（纯 Node，不 import 宿主包，可单测）。
//
// 分工：service.js 只做「数据根解析 + Remote 声明 + 会话记忆」；本文件承载
// 项目/证据/结论/功能/未知项/规格包的实际逻辑，tools.js 与 Remote 共用同一份实现。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArchitectures, summarizeAppBundle } from "./core/app-bundle.js";
import { buildAttestation } from "./core/attestation.js";
import {
  evaluateBudget,
  evaluateUnlock,
  normalizeAutonomy,
  normalizeBudget,
} from "./core/autonomy.js";
import { buildSpecPack, redactPack, renderSpecMarkdown, writeSpecPack } from "./core/brief.js";
import { buildBundle } from "./core/bundle.js";
import { createCheckers } from "./core/checks.js";
import { hashTree, shortDigest } from "./core/digest.js";
import { awaitLogin } from "./core/login-wait.js";
import { gradeCapabilities } from "./core/manifest.js";
import {
  CasefileInputError,
  newId,
  normalizeClaim,
  normalizeEvidence,
  normalizeFeature,
  normalizeObligation,
  normalizeUnknown,
  nowIso,
  projectStats,
} from "./core/model.js";
import { buildOverview, summarizeOverview } from "./core/overview.js";
import {
  buildReport,
  computeCoverage,
  evaluateClose,
  renderReportHtml,
  renderReportMarkdown,
} from "./core/report.js";
import {
  evaluateStop,
  findStaleObligations,
  latestBuild,
  nextRound,
  normalizeBuildRun,
  summarizeRuns,
} from "./core/runs.js";
import { CaseStoreError } from "./core/store.js";

/** 业务错误：带稳定 code（由 service 映射成 RemoteError / 工具错误）。 */
export class CasefileActionError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "CasefileActionError";
    this.code = code;
  }
}

/**
 * 造一组动作。
 * @param {{
 *   store: import("./core/store.js").CaseStore,
 *   currentProject?: Map<string, string>,
 *   dataRoot?: string,
 *   runner?: (command: string, options?: Record<string, any>) => Promise<Record<string, any>>,
 *   onWaitChange?: (state: Record<string, any> | null) => void,
 *   provenance?: () => { reaVersion?: string | null, capabilityHash?: string | null, toolNames?: readonly string[] } | null,
 *   sessions?: {
 *     create(input: { cwd: string }): Promise<{ sessionId: string }>,
 *     prompt(input: { sessionId: string, text: string }): Promise<void>,
 *     wait(input: { sessionId: string, timeoutMs?: number }): Promise<{ reason: string, output?: any }>,
 *   },
 * }} options
 */
export function createActions(options) {
  const store = options.store;
  const currentProject = options.currentProject ?? new Map();
  const dataRoot = options.dataRoot ?? store.rootDir;
  const sessions = options.sessions;
  const onWaitChange = options.onWaitChange;
  const runner = options.runner ?? null;
  const provenance = options.provenance ?? null;
  // checker 需要固定形状的 runner；外层 runner 更宽松，这里做一次归一。
  const checkerRunner =
    runner == null
      ? undefined
      : async (/** @type {string} */ command, /** @type {any} */ runOptions) => {
          const result = await runner(command, runOptions);
          return {
            exitCode:
              typeof result?.exitCode === "number"
                ? result.exitCode
                : typeof result?.code === "number"
                  ? result.code
                  : 0,
            stdout: String(result?.stdout ?? ""),
            stderr: String(result?.stderr ?? ""),
          };
        };
  const checkers = createCheckers({ runner: checkerRunner });

  /**
   * 把 Info.plist（XML 或二进制）转成 JSON 对象。
   * @param {string} plistPath
   * @returns {Promise<Record<string, any>>}
   */
  const readPlistAsJson = async (/** @type {string} */ plistPath) => {
    if (runner != null) {
      const result = await runner(`plutil -convert json -o - ${JSON.stringify(plistPath)}`);
      const text = String(result?.stdout ?? "").trim();
      if (text !== "") return JSON.parse(text);
    }
    // 没有 runner 或 plutil 没输出：只在文件本身就是 JSON 形式时接受
    const raw = readFileSync(plistPath, "utf8").trim();
    if (raw.startsWith("{")) return JSON.parse(raw);
    throw new CasefileInputError(
      "invalid-input",
      "无法解析 Info.plist：它可能是 XML 或二进制，需要在 macOS 上用 plutil 转换（runner 不可用）",
    );
  };

  /**
   * @param {string} projectId
   * @returns {Record<string, any>}
   */
  const requireProject = (projectId) => {
    const id = String(projectId ?? "");
    const project = store.getProject(id);
    if (!project) throw new CaseStoreError("project-not-found", `项目不存在：${id || "(空)"}`);
    return project;
  };

  /**
   * @param {any} exec
   * @returns {string | undefined}
   */
  const sessionOf = (exec) => {
    const id = exec?.agent?.id;
    return typeof id === "string" && id !== "" ? id : undefined;
  };

  return {
    // ---------- 会话记忆 ----------

    /**
     * @param {any} exec
     * @param {string} projectId
     */
    remember(exec, projectId) {
      const sessionId = sessionOf(exec);
      if (sessionId) currentProject.set(sessionId, projectId);
    },

    /**
     * @param {any} exec
     * @returns {string | undefined}
     */
    recall(exec) {
      const sessionId = sessionOf(exec);
      return sessionId ? currentProject.get(sessionId) : undefined;
    },

    // ---------- 项目 ----------

    /** @returns {Promise<any[]>} */
    async listProjects() {
      return store.listProjects().map((project) => {
        const data = store.readAll(project.id);
        return projectStats(project, data);
      });
    },

    /**
     * @param {Record<string, any>} input
     * @param {any} [exec]
     * @returns {Promise<Record<string, any>>}
     */
    async openProject(input, exec) {
      const project = store.createProject(input ?? {});
      // 把"当时用的哪套工具"锚进项目：REA 版本 + 工具面哈希。
      const probe = typeof provenance === "function" ? provenance() : null;
      const anchored = probe
        ? store.updateProject(project.id, {
            reaVersion: probe.reaVersion ?? undefined,
            capabilityHash: probe.capabilityHash,
          })
        : project;
      if (exec) this.remember(exec, project.id);
      return anchored;
    },

    /**
     * @param {string} projectId
     * @returns {Promise<Record<string, any>>}
     */
    async detail(projectId) {
      const project = requireProject(projectId);
      const data = store.readAll(project.id);
      return {
        project,
        // 面板要显示当前自主性级别（L3 是危险状态，必须看得见）
        autonomy: normalizeAutonomy(project.autonomy),
        stats: projectStats(project, data),
        claims: data.claims,
        evidence: data.evidence,
        features: data.features,
        unknowns: data.unknowns,
        obligations: data.obligations,
        builds: data.builds,
        checks: data.checks,
        attestations: data.attestations,
      };
    },

    /**
     * @param {string} projectId
     * @param {Record<string, any>} patch
     * @returns {Promise<Record<string, any>>}
     */
    async updateProject(projectId, patch) {
      return store.updateProject(projectId, patch ?? {});
    },

    /**
     * @param {string} projectId
     * @param {ReturnType<typeof import("./core/manifest.js").diffCapabilities>} capabilities
     * @returns {Promise<Record<string, any>>}
     */
    async status(projectId, capabilities) {
      const detail = await this.detail(projectId);
      return { ...detail, capabilities: gradeCapabilities(capabilities) };
    },

    /**
     * @param {ReturnType<typeof import("./core/manifest.js").diffCapabilities>} capabilities
     * @returns {Promise<Record<string, any>>}
     */
    async diagnose(capabilities) {
      return {
        dataRoot,
        projects: store.listProjects().length,
        rea: {
          availableTools: capabilities.availableReaTools,
          present: capabilities.present,
          missingRequired: capabilities.missingRequired,
          missingOptional: capabilities.missingOptional,
          capabilityHash: capabilities.capabilityHash,
        },
        grade: gradeCapabilities(capabilities),
      };
    },

    // ---------- 证据 ----------

    /**
     * @param {string} projectId
     * @param {Record<string, any>} input
     * @param {any} [exec]
     * @returns {Promise<Record<string, any>>}
     */
    async addEvidence(projectId, input, exec) {
      const project = requireProject(projectId);
      // 产物接管：/tmp 里的东西会被清理，清了 sha256 就无法复算，项目只能停在 investigating。
      const archived =
        typeof input?.artifactPath === "string" && input.artifactPath.trim() !== ""
          ? store.archiveArtifact(project.id, input.artifactPath)
          : null;
      const record = normalizeEvidence({
        ...input,
        artifact: archived,
        sessionId: input?.sessionId ?? sessionOf(exec) ?? null,
      });
      store.appendRecord(project.id, "evidence", record);
      store.touch(project.id);
      store.audit(project.id, {
        actor: "agent",
        action: "evidence/add",
        target: record.id,
        detail: { kind: record.kind, confidence: record.confidence },
      });
      return record;
    },

    /**
     * @param {string} projectId
     * @param {Record<string, any>} [filter]
     * @returns {Promise<any[]>}
     */
    async listEvidence(projectId, filter = {}) {
      requireProject(projectId);
      return store.readRecords(projectId, "evidence").filter((item) => {
        if (filter?.kind && item.kind !== filter.kind) return false;
        if (filter?.confidence && item.confidence !== filter.confidence) return false;
        if (filter?.claimId && !(item.claimIds ?? []).includes(filter.claimId)) return false;
        return true;
      });
    },

    /**
     * @param {string} projectId
     * @param {string} evidenceId
     * @returns {Promise<Record<string, any>>}
     */
    async showEvidence(projectId, evidenceId) {
      requireProject(projectId);
      const found = store.readRecords(projectId, "evidence").find((item) => item.id === evidenceId);
      if (!found) throw new CaseStoreError("not-found", `证据不存在：${evidenceId}`);
      return found;
    },

    // ---------- 结论 ----------

    /**
     * @param {string} projectId
     * @param {Record<string, any>} input
     * @returns {Promise<Record<string, any>>}
     */
    async addClaim(projectId, input) {
      const project = requireProject(projectId);
      const record = normalizeClaim(input);
      store.appendRecord(project.id, "claims", record);
      store.touch(project.id);
      store.audit(project.id, {
        actor: "agent",
        action: "claim/add",
        target: record.id,
        detail: { kind: record.kind, status: record.status },
      });
      return record;
    },

    /**
     * @param {string} projectId
     * @param {Record<string, any>} [filter]
     * @returns {Promise<any[]>}
     */
    async listClaims(projectId, filter = {}) {
      requireProject(projectId);
      return store.readRecords(projectId, "claims").filter((item) => {
        if (typeof filter?.selected === "boolean" && item.selected !== filter.selected)
          return false;
        if (filter?.status && item.status !== filter.status) return false;
        if (filter?.featureId && !(item.featureIds ?? []).includes(filter.featureId)) return false;
        return true;
      });
    },

    /**
     * @param {string} projectId
     * @param {string} query
     * @returns {Promise<any[]>}
     */
    async searchClaims(projectId, query) {
      requireProject(projectId);
      const needle = String(query ?? "").toLowerCase();
      if (needle === "") return [];
      return store.readRecords(projectId, "claims").filter((item) => {
        const haystack = `${item.text ?? ""} ${(item.limitations ?? []).join(" ")}`.toLowerCase();
        return haystack.includes(needle);
      });
    },

    /**
     * 勾选/取消结论（append-only：追加同 id 的新记录，读时后者胜）。
     * @param {string} projectId
     * @param {string[]} claimIds
     * @param {boolean} selected
     * @returns {Promise<any[]>}
     */
    async selectClaims(projectId, claimIds, selected) {
      const project = requireProject(projectId);
      const wanted = new Set((Array.isArray(claimIds) ? claimIds : []).map(String));
      if (wanted.size === 0) {
        throw new CasefileInputError("invalid-input", "claimIds 不能为空");
      }
      const rows = store.readRecords(project.id, "claims");
      /** @type {any[]} */
      const updated = [];
      for (const claim of rows) {
        if (!wanted.has(claim.id)) continue;
        const next = { ...claim, selected: selected === true };
        store.appendRecord(project.id, "claims", next);
        updated.push(next);
      }
      if (updated.length === 0) {
        throw new CaseStoreError("not-found", `没有匹配的结论：${[...wanted].join("、")}`);
      }
      store.touch(project.id);
      store.audit(project.id, {
        actor: "agent",
        action: "claim/select",
        target: [...wanted].join(","),
        detail: { selected: selected === true, count: updated.length },
      });
      return updated;
    },

    // ---------- 功能 / 未知项 ----------

    /**
     * @param {string} projectId
     * @param {Record<string, any>} input
     * @returns {Promise<Record<string, any>>}
     */
    async addFeature(projectId, input) {
      const project = requireProject(projectId);
      const record = normalizeFeature(input);
      store.appendRecord(project.id, "features", record);
      store.touch(project.id);
      store.audit(project.id, {
        actor: "agent",
        action: "feature/add",
        target: record.id,
        detail: { name: record.name },
      });
      return record;
    },

    /**
     * @param {string} projectId
     * @returns {Promise<any[]>}
     */
    async listFeatures(projectId) {
      requireProject(projectId);
      return store.readRecords(projectId, "features");
    },

    /**
     * @param {string} projectId
     * @param {Record<string, any>} input
     * @returns {Promise<Record<string, any>>}
     */
    async addUnknown(projectId, input) {
      const project = requireProject(projectId);
      const record = normalizeUnknown(input);
      store.appendRecord(project.id, "unknowns", record);
      store.touch(project.id);
      store.audit(project.id, {
        actor: "agent",
        action: "unknown/add",
        target: record.id,
        detail: { severity: record.severity },
      });
      return record;
    },

    /**
     * @param {string} projectId
     * @returns {Promise<any[]>}
     */
    async listUnknowns(projectId) {
      requireProject(projectId);
      return store.readRecords(projectId, "unknowns");
    },

    /**
     * @param {string} projectId
     * @param {string} unknownId
     * @param {string} [note]
     * @returns {Promise<Record<string, any>>}
     */
    async resolveUnknown(projectId, unknownId, note) {
      const project = requireProject(projectId);
      const found = store.readRecords(project.id, "unknowns").find((item) => item.id === unknownId);
      if (!found) throw new CaseStoreError("not-found", `未知项不存在：${unknownId}`);
      /** @type {any} */
      const next = {
        ...found,
        status: "resolved",
        note: note == null ? (found.note ?? "") : String(note).slice(0, 2000),
        resolvedAt: nowIso(),
      };
      store.appendRecord(project.id, "unknowns", next);
      store.touch(project.id);
      store.audit(project.id, { actor: "agent", action: "unknown/resolve", target: next.id });
      return next;
    },

    // ---------- 义务与检查 ----------

    /**
     * @param {string} projectId
     * @param {Record<string, any>} input
     * @returns {Promise<Record<string, any>>}
     */
    async addObligation(projectId, input) {
      const project = requireProject(projectId);
      const record = normalizeObligation(input);
      store.appendRecord(project.id, "obligations", record);
      store.touch(project.id);
      store.audit(project.id, {
        actor: "agent",
        action: "obligation/add",
        target: record.id,
        detail: { kind: record.kind, authorityRequired: record.authorityRequired },
      });
      return record;
    },

    /**
     * @param {string} projectId
     * @returns {Promise<any[]>}
     */
    async listObligations(projectId) {
      requireProject(projectId);
      return store.readRecords(projectId, "obligations");
    },

    /**
     * 记录一次检查结果（M1 只落账；执行 checkers 是 M2）。
     * @param {string} projectId
     * @param {Record<string, any>} input
     * @returns {Promise<Record<string, any>>}
     */
    async addCheck(projectId, input) {
      const project = requireProject(projectId);
      const verdict = String(input?.verdict ?? "");
      if (!["pass", "fail", "unknown"].includes(verdict)) {
        throw new CasefileInputError(
          "invalid-input",
          `verdict 必须是 pass | fail | unknown，收到 ${JSON.stringify(input?.verdict)}`,
        );
      }
      const record = {
        id: newId("check"),
        obligationId: String(input?.obligationId ?? ""),
        checker: String(input?.checker ?? "manual"),
        checkerVersion: String(input?.checkerVersion ?? "1"),
        verdict,
        implementationDigest:
          input?.implementationDigest == null ? null : String(input.implementationDigest),
        originalDigest: input?.originalDigest == null ? null : String(input.originalDigest),
        evidenceFetchedAt:
          input?.evidenceFetchedAt == null ? nowIso() : String(input.evidenceFetchedAt),
        detail: input?.detail == null ? "" : String(input.detail).slice(0, 2000),
        at: nowIso(),
      };
      store.appendRecord(project.id, "checks", record);
      store.touch(project.id);
      store.audit(project.id, {
        actor: "agent",
        action: "check/add",
        target: record.id,
        detail: { obligationId: record.obligationId, verdict },
      });
      return record;
    },

    /**
     * @param {string} projectId
     * @param {string} [obligationId]
     * @returns {Promise<any[]>}
     */
    async listChecks(projectId, obligationId) {
      requireProject(projectId);
      const rows = store.readRecords(projectId, "checks");
      return obligationId == null
        ? rows
        : rows.filter((item) => item.obligationId === obligationId);
    },

    /**
     * 关闭义务的硬门（spec/03-acceptance.md §1.3）：
     * 必须有 fresh 的 PASS 检查，且实现/原件 digest 与义务绑定的一致。
     * @param {string} projectId
     * @param {string} obligationId
     * @param {{ checkId?: string, note?: string }} [input]
     * @returns {Promise<Record<string, any>>}
     */
    async closeObligation(projectId, obligationId, input = {}) {
      const project = requireProject(projectId);
      const obligations = store.readRecords(project.id, "obligations");
      const obligation = obligations.find((item) => item.id === obligationId);
      if (!obligation) {
        throw new CaseStoreError("not-found", `义务不存在：${obligationId}`);
      }
      if (obligation.status === "pass") return obligation;
      const checks = store
        .readRecords(project.id, "checks")
        .filter((item) => item.obligationId === obligationId);
      /** @type {string[]} */
      const blockers = [];
      const fresh = checks.filter((item) => {
        const age = Date.now() - Date.parse(item.evidenceFetchedAt ?? 0);
        return Number.isFinite(age) && age >= 0 && age <= 24 * 3600 * 1000;
      });
      const chosen =
        input.checkId == null
          ? fresh.filter((item) => item.verdict === "pass").at(-1)
          : checks.find((item) => item.id === input.checkId);
      if (!chosen) {
        // 没有可用的 PASS：如果存在检查，用最近一条的结论作为原因，便于用户看懂。
        const latest = checks.at(-1);
        if (!latest) blockers.push("no-fresh-check");
        else if (latest.verdict === "pass") blockers.push("stale-check");
        else blockers.push(`check-${latest.verdict}`);
      } else if (chosen.verdict !== "pass") {
        blockers.push(`check-${chosen.verdict}`);
      } else if (!fresh.includes(chosen)) {
        blockers.push("stale-check");
      }
      if (chosen && obligation.ownerDigest != null) {
        if (chosen.implementationDigest !== obligation.ownerDigest) {
          blockers.push("implementation-mismatch");
        }
      }
      if (blockers.length > 0) {
        throw new CasefileActionError(
          "obligationTooTall",
          `义务 ${obligationId} 还不能关闭：${blockers.join("、")}`,
        );
      }
      /** @type {any} */
      if (!chosen) throw new CasefileActionError("obligationTooTall", "缺少可用检查");
      /** @type {any} */
      const next = {
        ...obligation,
        status: "pass",
        checkIds: [...(obligation.checkIds ?? []), chosen.id],
        closedBy: "agent",
        closedAt: nowIso(),
        note: input.note == null ? "" : String(input.note).slice(0, 2000),
        version: Number(obligation.version ?? 1) + 1,
      };
      store.appendRecord(project.id, "obligations", next);
      store.touch(project.id);
      store.audit(project.id, {
        actor: "agent",
        action: "obligation/close",
        target: next.id,
        detail: { checkId: chosen.id },
      });
      return next;
    },

    /**
     * @param {string} projectId
     * @param {string} obligationId
     * @param {string} [note]
     * @returns {Promise<Record<string, any>>}
     */
    async reopenObligation(projectId, obligationId, note) {
      const project = requireProject(projectId);
      const obligations = store.readRecords(project.id, "obligations");
      const obligation = obligations.find((item) => item.id === obligationId);
      if (!obligation) throw new CaseStoreError("not-found", `义务不存在：${obligationId}`);
      /** @type {any} */
      const next = {
        ...obligation,
        status: "open",
        note: note == null ? (obligation.note ?? "") : String(note).slice(0, 2000),
        version: Number(obligation.version ?? 1) + 1,
      };
      store.appendRecord(project.id, "obligations", next);
      store.touch(project.id);
      store.audit(project.id, { actor: "agent", action: "obligation/reopen", target: next.id });
      return next;
    },

    // ---------- 构建 / 验收 ----------

    /**
     * 起一轮构建：跑命令、算实现 digest、落 BuildRun，并按新 digest 重算 stale。
     * @param {string} projectId
     * @param {{ command: string, cwd?: string, round?: number, timeoutMs?: number }} input
     * @returns {Promise<Record<string, any>>}
     */
    async startBuild(projectId, input) {
      const project = requireProject(projectId);
      const builds = store.readRecords(project.id, "builds");
      const requestedRound = Number(input?.round);
      const round =
        Number.isInteger(requestedRound) && requestedRound > 0 ? requestedRound : nextRound(builds);
      const startedAt = nowIso();
      const buildChecker = checkers.get("build");
      if (!buildChecker) throw new CasefileActionError("internal", "build checker 未注册");
      const result = await buildChecker.run({
        command: input?.command,
        cwd: input?.cwd,
        timeoutMs: input?.timeoutMs,
      });
      let implementationDigest = null;
      const implementationDir = input?.cwd == null ? null : String(input.cwd);
      if (implementationDir !== null) {
        try {
          implementationDigest = hashTree(implementationDir).digest;
        } catch (error) {
          /** @type {any} */
          const anyError = error;
          throw new CasefileInputError(
            "invalid-input",
            `无法计算实现 digest：${anyError?.message ?? String(error)}`,
          );
        }
      }
      const build = normalizeBuildRun({
        round,
        command: String(input.command),
        cwd: input?.cwd ?? null,
        status:
          result.verdict === "pass" ? "pass" : result.verdict === "unknown" ? "error" : "fail",
        exitCode: result.exitCode ?? null,
        implementationDigest,
        startedAt,
        endedAt: result.endedAt,
        detail: JSON.stringify(result.detail ?? {}),
      });
      store.appendRecord(project.id, "builds", build);
      store.touch(project.id);
      store.audit(project.id, {
        actor: "agent",
        action: "build/run",
        target: build.id,
        detail: {
          round: build.round,
          status: build.status,
          digest: shortDigest(implementationDigest),
        },
      });
      const stale = await this.refreshStaleness(project.id);
      return { build, stale, ...summarizeRuns(this.readRunData(project.id)) };
    },

    /**
     * 跑一条 checker 并落 CheckResult（绑定当前构建的实现 digest）。
     * @param {string} projectId
     * @param {{
     *   obligationId: string, checker: string, command?: string, cwd?: string,
     *   expect?: Record<string, any>, timeoutMs?: number,
     *   reference?: string, candidate?: string, minSimilarity?: number, allowSizeMismatch?: boolean,
     *   jsonPath?: string,
     * }} input
     * @returns {Promise<Record<string, any>>}
     */
    async runCheck(projectId, input) {
      const project = requireProject(projectId);
      const obligationId = String(input?.obligationId ?? "");
      const obligations = store.readRecords(project.id, "obligations");
      const obligation = obligations.find((item) => item.id === obligationId);
      if (!obligation) throw new CaseStoreError("not-found", `义务不存在：${obligationId}`);
      const checkerName = String(input?.checker ?? "cli");
      const checker = checkers.get(checkerName);
      if (!checker) {
        throw new CasefileInputError(
          "invalid-input",
          `未知 checker：${checkerName}（可用：${[...checkers.keys()].join("、")}）`,
        );
      }
      const builds = store.readRecords(project.id, "builds");
      const current = latestBuild(builds);
      if (!current) {
        throw new CasefileInputError(
          "invalid-input",
          "还没有构建记录：先 case_build 起一轮构建，检查结果才能绑定实现 digest",
        );
      }
      const result = await checker.run({
        command: input?.command,
        cwd: input?.cwd,
        timeoutMs: input?.timeoutMs,
        expect: input?.expect ?? {},
        reference: input?.reference,
        candidate: input?.candidate,
        minSimilarity: input?.minSimilarity,
        allowSizeMismatch: input?.allowSizeMismatch,
        jsonPath: input?.jsonPath,
      });
      const checkedAt = nowIso();
      const record = {
        id: newId("check"),
        obligationId,
        checker: checker.name,
        checkerVersion: checker.version,
        verdict: result.verdict,
        implementationDigest: current.implementationDigest ?? null,
        originalDigest: project.capabilityHash ?? null,
        evidenceFetchedAt: checkedAt,
        detail: JSON.stringify(result.detail ?? {}),
        exitCode: result.exitCode ?? null,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        at: checkedAt,
      };
      store.appendRecord(project.id, "checks", record);
      store.touch(project.id);
      store.audit(project.id, {
        actor: "agent",
        action: "check/run",
        target: record.id,
        detail: { obligationId, checker: checkerName, verdict: record.verdict },
      });
      return { check: record, obligation: obligation.id };
    },

    /**
     * 依据最新构建 digest 重开已失效的已关闭义务。
     * @param {string} projectId
     * @returns {Promise<any[]>}
     */
    async refreshStaleness(projectId) {
      const project = requireProject(projectId);
      const data = store.readAll(project.id);
      const current = latestBuild(data.builds);
      const stale = findStaleObligations({
        obligations: data.obligations,
        checks: data.checks,
        implementationDigest: current?.implementationDigest ?? null,
        originalDigest: project.capabilityHash ?? null,
      });
      /** @type {any[]} */
      const reopened = [];
      for (const entry of stale) {
        const obligation = data.obligations.find(
          (/** @type {any} */ item) => item.id === entry.obligationId,
        );
        if (!obligation) continue;
        const next = {
          ...obligation,
          status: "open",
          note: `stale: ${entry.reasons.join(",")}`,
          version: Number(obligation.version ?? 1) + 1,
        };
        store.appendRecord(project.id, "obligations", next);
        reopened.push({ obligationId: next.id, reasons: entry.reasons });
        store.audit(project.id, {
          actor: "agent",
          action: "obligation/stale",
          target: next.id,
          detail: { reasons: entry.reasons },
        });
      }
      if (reopened.length > 0) store.touch(project.id);
      return reopened;
    },

    /**
     * 读审计日志（只读）。
     * @param {string} projectId
     * @returns {any[]}
     */
    readAudit(projectId) {
      const project = requireProject(projectId);
      return store.readAudit(project.id);
    },

    /** @param {string} projectId */
    readRunData(projectId) {
      const data = store.readAll(projectId);
      return { builds: data.builds, checks: data.checks, obligations: data.obligations };
    },

    /**
     * 循环状态：轮次、停止条件、未关闭义务。
     * @param {string} projectId
     * @param {Record<string, any>} [stop]
     * @returns {Promise<Record<string, any>>}
     */
    async loopStatus(projectId, stop) {
      const project = requireProject(projectId);
      const data = store.readAll(project.id);
      const summary = summarizeRuns({
        builds: data.builds,
        checks: data.checks,
        obligations: data.obligations,
      });
      const verdict = evaluateStop({
        builds: data.builds,
        checks: data.checks,
        openObligations: summary.obligations.open,
        stop,
      });
      return {
        ...summary,
        stop: verdict,
        openObligations: data.obligations.filter((item) => item.status === "open"),
      };
    },

    // ---------- 自动循环（M3） ----------

    /**
     * 跑一轮自动循环：构建 → 对带 recipe 的未关闭义务逐个检查 → 通过就关闭 → 停止条件。
     * 不猜「像不像」：只跑义务自带的 check recipe，没有 recipe 的义务保持 open 并列入 needsRecipe。
     * @param {string} projectId
     * @param {{
     *   command: string, cwd?: string, round?: number, timeoutMs?: number,
     *   maxRounds?: number, stop?: Record<string, any>,
     * }} input
     * @returns {Promise<Record<string, any>>}
     */
    async advanceLoop(projectId, input) {
      const project = requireProject(projectId);
      const requestedMax = Number(input?.maxRounds);
      const maxRounds = Number.isInteger(requestedMax) && requestedMax > 0 ? requestedMax : 1;
      /** @type {any[]} */
      const rounds = [];
      for (let index = 0; index < maxRounds; index += 1) {
        const build = await this.startBuild(project.id, {
          command: input?.command,
          cwd: input?.cwd,
          timeoutMs: input?.timeoutMs,
        });
        /** @type {any[]} */
        const opened = store
          .readRecords(project.id, "obligations")
          .filter((item) => item.status === "open");
        const withRecipe = opened.filter((item) => item.check != null);
        const needsRecipe = opened.filter((item) => item.check == null).map((item) => item.id);
        /** @type {any[]} */
        const checked = [];
        // 构建失败时不做检查：在坏实现上跑检查没有意义，也容易产生误导性的绿灯。
        if (build.build.status === "pass") {
          for (const obligation of withRecipe) {
            const recipe = obligation.check;
            const result = await this.runCheck(project.id, {
              obligationId: obligation.id,
              checker: recipe.checker,
              command: recipe.command,
              cwd: recipe.cwd ?? input?.cwd,
              expect: recipe.expect ?? {},
              timeoutMs: recipe.timeoutMs,
            });
            let closed = null;
            if (result.check.verdict === "pass") {
              closed = await this.closeObligation(project.id, obligation.id, {
                checkId: result.check.id,
                note: "advanceLoop",
              });
            }
            checked.push({
              obligationId: obligation.id,
              verdict: result.check.verdict,
              status: closed ? "pass" : "open",
            });
          }
        }
        const status = await this.loopStatus(project.id, input?.stop);
        rounds.push({
          round: build.build.round,
          buildStatus: build.build.status,
          checked,
          needsRecipe,
          openObligations: status.obligations.open,
          stop: status.stop,
        });
        if (status.stop.stop) break;
        if (status.obligations.open === 0) break;
      }
      const final = await this.loopStatus(project.id, input?.stop);
      return {
        rounds,
        closed: final.obligations.pass,
        open: final.obligations.open,
        stop: final.stop,
        openObligations: final.openObligations,
        summary: `跑了 ${rounds.length} 轮；关闭 ${final.obligations.pass} 条；停止条件 ${final.stop.reason}`,
      };
    },

    // ---------- builder 会话（M2.5） ----------

    /**
     * 起一个 builder 会话：只把 spec pack 投喂给它，不让它拿到原件工具。
     * 说明：DSH 的 agent preset 目前无法用 bundle 名组合（见 runtime §10.7），
     * 因此这里用「独立会话 + 只投喂规格」做信息流隔离，而不是工具白名单。
     * @param {string} projectId
     * @param {{
     *   cwd: string, prompt?: string, featureIds?: string[], timeoutMs?: number,
     *   allowResearchTier?: boolean, reason?: string,
     * }} input
     * @returns {Promise<Record<string, any>>}
     */
    async startBuilder(projectId, input) {
      const project = requireProject(projectId);
      if (!sessions) {
        throw new CasefileActionError(
          "builder-unavailable",
          "会话服务不可用：宿主里没有 sessionController（headless 组合可能没有）",
        );
      }
      const cwd = String(input?.cwd ?? "").trim();
      if (cwd === "") throw new CasefileInputError("invalid-input", "cwd 不能为空");
      // 授权档闸门：research 档默认不允许「复刻」这种高争议动作，必须显式覆盖并留审计。
      if (project.authTier === "research" && input?.allowResearchTier !== true) {
        throw new CasefileActionError(
          "auth-tier-blocked",
          `项目授权档是 research：默认不许起复刻构建。确认有权复刻后，用 allowResearchTier 显式覆盖（会写审计）。`,
        );
      }
      if (project.authTier === "research" && input?.allowResearchTier === true) {
        store.audit(project.id, {
          actor: "agent",
          action: "auth/research-override",
          target: project.id,
          detail: { reason: String(input?.reason ?? "").slice(0, 500) },
        });
      }
      const data = store.readAll(project.id);
      const pack = buildSpecPack({
        project,
        ...data,
        ...(Array.isArray(input?.featureIds) && input.featureIds.length > 0
          ? {
              claims: data.claims.filter((item) =>
                input.featureIds?.some((id) => (item.featureIds ?? []).includes(id)),
              ),
            }
          : {}),
      });
      if (pack.claims.length === 0) {
        throw new CasefileActionError(
          "nothing-selected",
          "没有选中的结论：builder 需要至少一条规格，先勾选结论",
        );
      }
      const prompt =
        typeof input?.prompt === "string" && input.prompt.trim() !== ""
          ? input.prompt
          : [
              "你在做一次「按规格复刻」的构建任务。",
              "",
              "只允许依据下面的规格包实现，不要读取或寻找原始目标；规格里没写的不要臆测。",
              "",
              "```markdown",
              renderSpecMarkdown(redactPack(pack)),
              "```",
              "",
              "完成后简述你实现了哪些功能、哪些做不到（以 UNKNOWN 记录原因）。",
            ].join("\n");
      const created = await sessions.create({ cwd });
      const sessionId = String(created.sessionId);
      // builder 只该收到规格包：把它登记为"只读会话"，写类工具会拒绝它。
      store.recordBuilderSession(sessionId);
      await sessions.prompt({ sessionId, text: prompt });
      const record = {
        id: newId("builder"),
        sessionId,
        cwd,
        round: nextRound(store.readRecords(project.id, "builds")),
        startedAt: nowIso(),
        featureIds: Array.isArray(input?.featureIds) ? input.featureIds.map(String) : [],
        claims: pack.claims.length,
      };
      store.appendRecord(project.id, "builds", {
        id: `builder-${record.id}`,
        round: record.round,
        command: `builder-session:${sessionId}`,
        cwd,
        status: "running",
        exitCode: null,
        implementationDigest: null,
        startedAt: record.startedAt,
        endedAt: null,
        detail: `投喂 ${pack.claims.length} 条结论`,
        artifacts: [],
        builderSessionId: sessionId,
      });
      const attestation = buildAttestation({
        project,
        prompt,
        pack,
        sessionId,
        builderId: record.id,
        override: input?.allowResearchTier === true,
        reason: input?.reason,
      });
      store.appendRecord(project.id, "attestations", attestation);
      store.touch(project.id);
      store.audit(project.id, {
        actor: "agent",
        action: "builder/start",
        target: sessionId,
        detail: {
          round: record.round,
          claims: pack.claims.length,
          cleanRoomInstruction: attestation.cleanRoomInstruction,
          promptDigest: attestation.shortPromptDigest,
        },
      });
      return {
        builder: record,
        promptLength: prompt.length,
        attestation: {
          promptDigest: attestation.shortPromptDigest,
          cleanRoomInstruction: attestation.cleanRoomInstruction,
          toolIsolation: attestation.toolIsolation,
        },
      };
    },

    /**
     * 等 builder 会话停下（idle / 需要输入 / 超时）。
     * @param {string} projectId
     * @param {{ sessionId: string, timeoutMs?: number }} input
     * @returns {Promise<Record<string, any>>}
     */
    async awaitBuilder(projectId, input) {
      requireProject(projectId);
      if (!sessions) {
        throw new CasefileActionError("builder-unavailable", "会话服务不可用");
      }
      const sessionId = String(input?.sessionId ?? "");
      if (sessionId === "") throw new CasefileInputError("invalid-input", "sessionId 不能为空");
      const result = await sessions.wait({ sessionId, timeoutMs: input?.timeoutMs });
      return {
        sessionId,
        reason: result.reason,
        output: result.output ?? null,
        stopped: result.reason === "idle" || result.reason === "input-required",
      };
    },

    /**
     * 端到端一轮：起 builder（可选）→ 等它停 → 构建 → 检查 → 关闭 → 报告停止条件。
     * 这是 spec 里「builder 停下 → 自动 build → 自动 check」的落点。
     * @param {string} projectId
     * @param {{
     *   builder?: {
     *     cwd: string, prompt?: string, featureIds?: string[], timeoutMs?: number,
     *     allowResearchTier?: boolean, reason?: string,
     *   },
     *   command?: string, cwd?: string, maxRounds?: number, timeoutMs?: number,
     *   stop?: Record<string, any>,
     * }} input
     * @returns {Promise<Record<string, any>>}
     */
    async runCycle(projectId, input) {
      const project = requireProject(projectId);
      /** @type {Record<string, any> | null} */
      let builder = null;
      if (input?.builder != null) {
        const started = await this.startBuilder(project.id, {
          cwd: input.builder.cwd,
          prompt: input.builder.prompt,
          featureIds: input.builder.featureIds,
          allowResearchTier: input.builder.allowResearchTier,
          reason: input.builder.reason,
        });
        const awaited = await this.awaitBuilder(project.id, {
          sessionId: started.builder.sessionId,
          timeoutMs: input.builder.timeoutMs ?? 120_000,
        });
        builder = {
          sessionId: started.builder.sessionId,
          claims: started.builder.claims,
          reason: awaited.reason,
        };
      }
      const command = input?.command;
      if (typeof command !== "string" || command.trim() === "") {
        throw new CasefileInputError("invalid-input", "runCycle 需要 command（构建命令）");
      }
      // L3 无人值守：预算与"任一失败即停"在循环前/后强制生效，不可由调用方放宽。
      const autonomy = normalizeAutonomy(project.autonomy);
      /** @type {{ maxRounds: number, maxBuilds: number, maxWallClockMs: number } | null} */
      let budget = null;
      if (autonomy.level === "L3") {
        budget = normalizeBudget(autonomy.budget);
        const existing = store.readAll(project.id).builds;
        const preStop = evaluateBudget({
          builds: existing,
          startedAt: autonomy.unlockedAt,
          budget,
        });
        if (preStop.stop) {
          store.audit(project.id, {
            actor: "agent",
            action: "autonomy/stop",
            target: project.id,
            detail: { reason: preStop.reason, ...preStop.detail },
          });
          throw Object.assign(new Error(`L3 停止：${preStop.reason}`), {
            code: "autonomy-stop",
            reason: preStop.reason,
            detail: preStop.detail,
          });
        }
      }
      const loop = await this.advanceLoop(project.id, {
        command,
        cwd: input?.cwd,
        maxRounds: input?.maxRounds,
        timeoutMs: input?.timeoutMs,
        stop: input?.stop,
      });
      return {
        builder,
        loop,
        stop: loop.stop,
        summary: `${builder ? `builder ${builder.reason}；` : ""}${loop.summary}`,
      };
    },

    // ---------- 跨项目总览（M4） ----------

    /**
     * 所有项目的只读总览。
     * @returns {Promise<Record<string, any>>}
     */
    async overview() {
      const projects = store.listProjects();
      /** @type {Record<string, any>} */
      const dataById = {};
      for (const project of projects) {
        dataById[project.id] = store.readAll(project.id);
      }
      const overview = buildOverview(projects, dataById);
      return { ...overview, summary: summarizeOverview(overview) };
    },

    // ---------- 自主性阶梯 ----------

    /**
     * 解锁 / 降级自主性。L3 有硬条件，不满足就拒绝并列出 blocker。
     * @param {string} projectId
     * @param {{ level?: string, budget?: Record<string, any> | null }} input
     * @returns {Promise<Record<string, any>>}
     */
    async setAutonomy(projectId, input) {
      const project = requireProject(projectId);
      const level = String(input?.level ?? "L3");
      if (!["L0", "L1", "L2", "L3"].includes(level)) {
        throw new CasefileInputError("invalid-input", `未知级别：${level}`);
      }
      if (level !== "L3") {
        // 降级永远允许且立即生效：这是"停"的开关。
        const next = store.updateProject(project.id, {
          autonomy: { level, unlockedAt: null, budget: null },
        });
        store.audit(project.id, {
          actor: "agent",
          action: "autonomy/lock",
          target: project.id,
          detail: { level },
        });
        return { project: next, autonomy: normalizeAutonomy(next.autonomy) };
      }
      const data = store.readAll(project.id);
      const unlock = evaluateUnlock({
        project,
        obligations: data.obligations,
        budget: input?.budget,
      });
      if (!unlock.ok) {
        throw Object.assign(new Error(`L3 解锁被拒绝：${unlock.blockers.join("、")}`), {
          code: "autonomy-blocked",
          blockers: unlock.blockers,
        });
      }
      const next = store.updateProject(project.id, {
        autonomy: {
          level: "L3",
          unlockedAt: nowIso(),
          budget: unlock.budget,
        },
      });
      store.audit(project.id, {
        actor: "agent",
        action: "autonomy/unlock",
        target: project.id,
        detail: { level, budget: unlock.budget, obligations: data.obligations.length },
      });
      return { project: next, autonomy: normalizeAutonomy(next.autonomy) };
    },

    /**
     * 当前自主性状态（含 L3 前置条件检查，便于面板展示"为什么不能升"）。
     * @param {string} projectId
     * @returns {Promise<Record<string, any>>}
     */
    async autonomyStatus(projectId) {
      const project = requireProject(projectId);
      const data = store.readAll(project.id);
      const autonomy = normalizeAutonomy(project.autonomy);
      const unlock = evaluateUnlock({
        project,
        obligations: data.obligations,
        budget: autonomy.budget,
      });
      return { autonomy, unlock: { ok: unlock.ok, blockers: unlock.blockers } };
    },

    // ---------- 等登录（人机协作） ----------

    /**
     * 轮询等用户完成登录。带超时，不假装成功。
     * @param {string} projectId
     * @param {{
     *   endpoint: string, urlPrefix?: string, readyJs?: string,
     *   pollMs?: number, timeoutMs?: number,
     * }} input
     * @returns {Promise<Record<string, any>>}
     */
    async awaitLogin(projectId, input) {
      const project = requireProject(projectId);
      const startedAt = nowIso();
      const endpoint = String(input?.endpoint ?? "").trim();
      if (endpoint === "") {
        throw new CasefileInputError(
          "invalid-input",
          "endpoint 不能为空（形如 http://127.0.0.1:9223）",
        );
      }
      onWaitChange?.({
        active: true,
        projectId: project.id,
        endpoint,
        startedAt,
        hint: "请在弹出的浏览器窗口里完成登录；就绪后会自动继续。",
      });
      let result;
      try {
        result = await awaitLogin({
          endpoint,
          urlPrefix: input?.urlPrefix,
          readyJs: input?.readyJs,
          pollMs: input?.pollMs,
          timeoutMs: input?.timeoutMs,
        });
      } finally {
        onWaitChange?.(null);
      }
      store.audit(project.id, {
        actor: "agent",
        action: "access/await-login",
        target: endpoint,
        detail: { status: result.status, attempts: result.attempts, waitedMs: result.waitedMs },
      });
      return result;
    },

    // ---------- 覆盖率 / 关闭 / 报告（M3 收尾） ----------

    /**
     * macOS .app 勘察第一跳：读 Info.plist + 可执行架构，给一屏摘要。
     * 依赖 runner 调 plutil / lipo（都是系统自带）；拿不到就标 null，不猜。
     * @param {{ path: string }} input
     * @returns {Promise<Record<string, any>>}
     */
    async inspectAppBundle(input) {
      const appPath = String(input?.path ?? "").trim();
      if (appPath === "") {
        throw new CasefileInputError(
          "invalid-input",
          "path 不能为空（形如 /Applications/Foo.app）",
        );
      }
      const plistPath = join(appPath, "Contents", "Info.plist");
      if (!existsSync(plistPath)) {
        throw new CasefileInputError("invalid-input", `不是 macOS 应用包：缺 ${plistPath}`);
      }
      // Info.plist 可能是 XML（实测 Bob.app 就是），也可能是二进制；统一交给 plutil 转 JSON。
      // 直接 JSON.parse 会在 XML 上炸——真实使用一轮就踩到了。
      const plist = await readPlistAsJson(plistPath);
      const executableName =
        typeof plist.CFBundleExecutable === "string" ? plist.CFBundleExecutable : null;
      const executablePath =
        executableName == null ? null : join(appPath, "Contents", "MacOS", executableName);
      /** @type {string[]} */
      let architectures = [];
      if (executablePath != null && runner != null && existsSync(executablePath)) {
        try {
          const result = await runner(`lipo -archs ${JSON.stringify(executablePath)}`, {
            timeoutMs: 15000,
          });
          const out = typeof result?.stdout === "string" ? result.stdout : "";
          architectures = parseArchitectures(out);
        } catch {
          architectures = [];
        }
      }
      return summarizeAppBundle(plist, {
        architectures,
        executablePath: executablePath ?? undefined,
        infoPlistPath: plistPath,
      });
    },

    /**
     * 归档项目（非破坏性）：误建或暂存的项目收起来，文件都在。
     * @param {string} projectId
     * @param {{ reason?: string }} [options]
     * @returns {Promise<Record<string, any>>}
     */
    async archiveProject(projectId, options = {}) {
      const project = store.archiveProject(projectId, options?.reason);
      store.audit(project.id, {
        actor: "agent",
        action: "project/archive",
        target: project.id,
        detail: { reason: String(options?.reason ?? "").slice(0, 200) },
      });
      return { project };
    },

    /**
     * 丢弃项目：整个目录移进 dataRoot/trash（可手动移回）。
     * 破坏性，必须 confirm。
     * @param {string} projectId
     * @param {{ confirm?: boolean }} [options]
     * @returns {Promise<Record<string, any>>}
     */
    async dropProject(projectId, options = {}) {
      const project = requireProject(projectId);
      if (options?.confirm !== true) {
        throw new CasefileActionError(
          "confirm-required",
          `丢弃项目会把 projects/${project.id} 整个移进 trash（可手动移回）。确认请传 confirm: true。`,
        );
      }
      const result = store.dropProject(project.id);
      return { trashedTo: result.trashedTo, project: result.project };
    },

    /**
     * 项目覆盖率与关闭闸门状态（只读预览，不写状态）。
     * @param {string} projectId
     * @param {{ minCoverage?: number, maxCheckAgeMs?: number }} [options]
     * @returns {Promise<Record<string, any>>}
     */
    async closePreview(projectId, options = {}) {
      const project = requireProject(projectId);
      const data = store.readAll(project.id);
      const current = latestBuild(data.builds);
      const verdict = evaluateClose({
        obligations: data.obligations,
        unknowns: data.unknowns,
        checks: data.checks,
        implementationDigest: current?.implementationDigest ?? null,
        minCoverage: options.minCoverage,
        maxCheckAgeMs: options.maxCheckAgeMs,
      });
      return { project: project.id, ...verdict };
    },

    /**
     * 关闭项目（硬门不通过就拒绝，且写审计）。
     * @param {string} projectId
     * @param {{ minCoverage?: number, note?: string }} [options]
     * @returns {Promise<Record<string, any>>}
     */
    async closeProject(projectId, options = {}) {
      const project = requireProject(projectId);
      if (project.state === "closed") return { project, alreadyClosed: true };
      const preview = await this.closePreview(project.id, options);
      if (!preview.ok) {
        throw Object.assign(new Error(`项目还不能关闭：${preview.blockers.join("、")}`), {
          code: "coverage-not-met",
          blockers: preview.blockers,
        });
      }
      const next = {
        ...project,
        state: "closed",
        closedAt: nowIso(),
        coverage: preview.coverage,
        note: options?.note == null ? "" : String(options.note).slice(0, 2000),
      };
      store.writeJson(join(store.projectDir(project.id), "project.json"), next);
      store.audit(project.id, {
        actor: "agent",
        action: "project/close",
        target: project.id,
        detail: { coverage: preview.coverage.ratio.toFixed(2) },
      });
      return { project: next, coverage: preview.coverage };
    },

    /**
     * 导出验收报告（md + json）。
     * @param {string} projectId
     * @returns {Promise<Record<string, any>>}
     */
    /**
     * 导出报告。
     * @param {string} projectId
     * @param {{ format?: "md" | "html" | "both" }} [options]
     * @returns {Promise<Record<string, any>>}
     */
    async exportReport(projectId, options = {}) {
      const format = options?.format ?? "md";
      if (!["md", "html", "both"].includes(format)) {
        throw new CasefileInputError("invalid-input", `format 只能是 md / html / both：${format}`);
      }
      const project = requireProject(projectId);
      const data = store.readAll(project.id);
      const current = latestBuild(data.builds);
      const coverage = computeCoverage(data.obligations);
      const stop = evaluateStop({
        builds: data.builds,
        checks: data.checks,
        openObligations: coverage.open,
      });
      const report = buildReport({ project, data, coverage, stop });
      const stamp = String(report.generatedAt).replace(/[:.]/g, "-");
      const dir = join(store.projectDir(project.id), "reports", stamp);
      mkdirSync(dir, { recursive: true });
      /** @type {string[]} */
      const files = [];
      if (format === "md" || format === "both") {
        writeFileSync(join(dir, "report.md"), `${renderReportMarkdown(report)}\n`, "utf8");
        files.push("report.md");
      }
      if (format === "html" || format === "both") {
        writeFileSync(join(dir, "report.html"), `${renderReportHtml(report)}\n`, "utf8");
        files.push("report.html");
      } else {
        // md 模式保持旧行为：仍然写 report.json 供程序消费
      }
      writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      files.push("report.json");
      store.audit(project.id, {
        actor: "agent",
        action: "report/export",
        target: dir,
        detail: {
          coverage: coverage.ratio.toFixed(2),
          digest: shortDigest(current?.implementationDigest),
        },
      });
      return {
        path: dir,
        files,
        coverage,
        summary: `报告已写入 ${dir}（覆盖率 ${(coverage.ratio * 100).toFixed(0)}%）`,
      };
    },

    /**
     * 导出机器可读证据包（全量账本，确定性、可校验）。
     * @param {string} projectId
     * @param {{ redact?: boolean }} [options]
     * @returns {Promise<Record<string, any>>}
     */
    async exportBundle(projectId, options = {}) {
      const project = requireProject(projectId);
      const data = store.readAll(project.id);
      const coverage = computeCoverage(data.obligations);
      const build = buildBundle({
        project,
        evidence: data.evidence,
        claims: data.claims,
        obligations: data.obligations,
        checks: data.checks,
        unknowns: data.unknowns,
        coverage,
        counts: {
          evidence: data.evidence.length,
          claims: data.claims.length,
          obligations: data.obligations.length,
          checks: data.checks.length,
          unknowns: data.unknowns.length,
        },
        redact: options?.redact !== false,
      });
      const stamp = String(build.generatedAt).replace(/[:.]/g, "-");
      const dir = join(store.projectDir(project.id), "bundles", stamp);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "bundle.json");
      writeFileSync(file, `${JSON.stringify(build, null, 2)}\n`, "utf8");
      store.audit(project.id, {
        actor: "agent",
        action: "bundle/export",
        target: dir,
        detail: {
          digest: build.integrity.digest.slice(0, 16),
          redacted: options?.redact !== false,
        },
      });
      return {
        path: dir,
        files: ["bundle.json"],
        integrity: build.integrity.digest,
        generatedAt: build.generatedAt,
        summary: `证据包已写入 ${dir}（integrity ${build.integrity.digest.slice(0, 16)}）`,
      };
    },

    // ---------- 规格包 ----------

    /**
     * @param {string} projectId
     * @param {{ redact?: boolean, redactOptions?: Record<string, any> }} [options]
     * @returns {Promise<Record<string, any>>}
     */
    async exportSpecPack(projectId, options = {}) {
      const project = requireProject(projectId);
      const data = store.readAll(project.id);
      const pack = buildSpecPack({ project, ...data });
      if (pack.claims.length === 0) {
        throw new CasefileActionError(
          "nothing-selected",
          "没有选中的结论：先勾选要导出的结论（case_claim select）",
        );
      }
      const written = writeSpecPack({
        projectDir: store.projectDir(project.id),
        pack,
        redact: options?.redact !== false,
        redactOptions: {
          home: process.env.HOME ?? process.env.USERPROFILE,
          cwd: process.cwd(),
          extraPaths: [dataRoot],
          ...(options?.redactOptions ?? {}),
        },
      });
      store.audit(project.id, {
        actor: "agent",
        action: "spec/export",
        target: written.dir,
        detail: { claims: pack.claims.length, redact: options?.redact !== false },
      });
      return {
        data: {
          path: written.dir,
          files: written.files.map((file) => file.split("/").slice(-1)[0]),
          claims: pack.claims.length,
          evidence: pack.evidence.length,
          features: pack.features.length,
          openUnknowns: pack.unknowns.length,
          integrity: shortDigest(pack.integrity),
        },
        summary: `规格包已写入 ${written.dir}（${pack.claims.length} 条结论 / ${pack.unknowns.length} 个未知项）`,
      };
    },
  };
}

/** @typedef {ReturnType<typeof createActions>} CasefileActions */
