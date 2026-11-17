// @ts-check
// actions.js：casefile 的全部业务动作（纯 Node，不 import 宿主包，可单测）。
//
// 分工：service.js 只做「数据根解析 + Remote 声明 + 会话记忆」；本文件承载
// 项目/证据/结论/功能/未知项/规格包的实际逻辑，tools.js 与 Remote 共用同一份实现。

import { buildSpecPack, writeSpecPack } from "./core/brief.js";
import { createCheckers } from "./core/checks.js";
import { hashTree, shortDigest } from "./core/digest.js";
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
 * }} options
 */
export function createActions(options) {
  const store = options.store;
  const currentProject = options.currentProject ?? new Map();
  const dataRoot = options.dataRoot ?? store.rootDir;
  const checkers = createCheckers(
    /** @type {any} */ (options.runner ? { runner: options.runner } : {}),
  );

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
      if (exec) this.remember(exec, project.id);
      return project;
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
        stats: projectStats(project, data),
        claims: data.claims,
        evidence: data.evidence,
        features: data.features,
        unknowns: data.unknowns,
        obligations: data.obligations,
        builds: data.builds,
        checks: data.checks,
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
      const record = normalizeEvidence({
        ...input,
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
     * @param {{ obligationId: string, checker: string, command: string, cwd?: string, expect?: Record<string, any>, timeoutMs?: number }} input
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
