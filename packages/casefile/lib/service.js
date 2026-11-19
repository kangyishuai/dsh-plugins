// @ts-check
// service.js：casefile 的 Host 半。**薄桥接**：数据根解析 + Remote 声明 + 工具注册。
// 业务逻辑全部在 ./actions.js（可单测）；Remote 方法必须声明在**被导出的类自身原型**上
// （否则 /api/casefile/* 返回 404，见 docs/runtime/0.2.1-rc.5.md §6.10）。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

import { createActions } from "./actions.js";
import { diffCapabilities, gradeCapabilities } from "./core/manifest.js";
import { buildProvenance, parsePackageVersion, parseReaVersion } from "./core/provenance.js";
import { CaseStore } from "./core/store.js";
import { buildToolDefinitions } from "./tools.js";

/**
 * 运行时不支持装饰器语法，用命令式方式登记 Remote（与 advisor / projects 同法）。
 * @param {any} Proto
 * @param {string} method
 * @returns {void}
 */
function declareRemote(Proto, method) {
  /** @type {Function[]} */
  const initializers = [];
  Remote(method)(void 0, {
    name: method,
    static: false,
    private: false,
    addInitializer(/** @type {Function} */ initializer) {
      initializers.push(initializer);
    },
  });
  if (initializers.length !== 1) {
    throw new Error(`casefile: cannot declare Remote method ${method}`);
  }
  initializers[0].call(Object.create(Proto.prototype));
}

/**
 * 数据根：显式配置优先；否则 `<DSH_HOME>/casefile`，再退 `~/.dsh/casefile`。
 * @param {Record<string, any> | undefined} config
 * @returns {string}
 */
export function resolveDataRoot(config) {
  if (config && typeof config.dataRoot === "string" && config.dataRoot.trim() !== "") {
    return config.dataRoot;
  }
  const home = process.env.DSH_HOME;
  if (typeof home === "string" && home.trim() !== "") return `${home}/casefile`;
  const userHome = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return userHome === "" ? ".dsh/casefile" : `${userHome}/.dsh/casefile`;
}

/**
 * 内部错误 → RemoteError（客户端能看到稳定 code）。
 * @param {unknown} error
 * @returns {never}
 */
function fail(error) {
  const anyError = /** @type {any} */ (error);
  const code = typeof anyError?.code === "string" ? anyError.code : "internal";
  const message = String(anyError?.message ?? error ?? "unknown error");
  // 业务拒绝（能说清「卡在哪」的）走 bad-request，保留原始消息；
  // 只有真正意料之外的错误才用 internal + [code] 前缀。
  const BUSINESS_CODES = new Set([
    "invalid-input",
    "bad-project-id",
    "nothing-selected",
    "project-exists",
    "not-found",
    "confirm-required",
    "project-not-found",
    "obligationTooTall",
    "coverage-not-met",
    "builder-unavailable",
    "auth-tier-blocked",
  ]);
  if (BUSINESS_CODES.has(code)) {
    throw new RemoteError("gateway/bad-request", message, {});
  }
  throw new RemoteError("gateway/internal", `[${code}] ${message}`, {});
}

/** casefile 服务。 */
export class CasefileService extends TypertRemoteService {
  /**
   * @param {any} ctx
   * @param {Record<string, any>} [config]
   */
  constructor(ctx, config) {
    super(ctx, "casefile");
    this.config = config ?? {};
    this.logger = ctx?.logger ?? console;
    this.dataRoot = resolveDataRoot(this.config);
    this.store = new CaseStore({ dataRoot: this.dataRoot, logger: this.logger });
    /** 会话 → 最近打开的项目（工具省略 projectId 时用）。 @type {Map<string, string>} */
    this.currentProject = new Map();
    this.accessWait = null;
    // casefile 自己起子进程读系统信息（plutil/lipo）；这类只读命令不走会话终端，
    // 避免污染用户 shell 历史，也不需要交互。
    this.runner = async (/** @type {string} */ command, /** @type {any} */ options) => {
      const { exec } = await import("node:child_process");
      return await new Promise((resolve, reject) => {
        exec(command, { timeout: options?.timeoutMs ?? 15000 }, (error, stdout, stderr) => {
          if (error && !stdout) reject(error);
          else
            resolve({
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              code: error ? 1 : 0,
            });
        });
      });
    };
    this.actions = createActions(this.actionOptions());
    this.installSessions();
    this.installTools();
    this.logger.info?.(`[casefile] loaded, dataRoot=${this.dataRoot}`);
  }

  /**
   * 运行时能力探测：当前可见的 REA 工具。
   * @returns {ReturnType<typeof diffCapabilities>}
   */
  capabilities() {
    try {
      const tools = this.ctx.get?.("tools");
      const definitions = tools?.definitions?.() ?? [];
      return diffCapabilities(
        definitions.map((/** @type {any} */ item) => String(item?.name ?? "")),
      );
    } catch {
      return diffCapabilities([]);
    }
  }

  /**
   * 探测当前 REA 版本与工具面哈希，用于把"当时的工具"锚进项目。
   * 版本来源：profile patch 文件里实际被启动的 `rea-agents@x.y.z`；
   * 找不到就留 null（不猜），工具面哈希始终可算。
   * @returns {{ reaVersion: string | null, capabilityHash: string, reaToolCount: number, probedAt: string }}
   */
  provenance() {
    let toolNames = [];
    try {
      const tools = this.ctx.get?.("tools");
      const definitions = tools?.definitions?.() ?? [];
      toolNames = definitions
        .map((/** @type {any} */ item) => String(item?.name ?? ""))
        .filter((/** @type {string} */ name) => name.startsWith("mcp__rea__"));
    } catch {
      toolNames = [];
    }
    return buildProvenance({ toolNames, reaVersion: this.detectReaVersion() });
  }

  /**
   * 从本机 DSH patch 文件 / 全局安装里找 REA 版本。
   * @returns {string | null}
   */
  detectReaVersion() {
    const paths = [
      process.env.DSH_HOME ? join(process.env.DSH_HOME, "cordis.patch.yml") : null,
      join(homedir(), ".dsh", "cordis.patch.yml"),
    ].filter((item) => typeof item === "string");
    for (const patchPath of paths) {
      try {
        if (!existsSync(patchPath)) continue;
        const found = parseReaVersion(readFileSync(patchPath, "utf8"));
        if (found != null) return found;
      } catch {
        // 读不到就继续试下一个来源
      }
    }
    try {
      const meta = join(
        homedir(),
        ".npm-global",
        "lib",
        "node_modules",
        "rea-agents",
        "package.json",
      );
      if (existsSync(meta)) return parsePackageVersion(readFileSync(meta, "utf8"));
    } catch {
      // 忽略
    }
    return null;
  }

  /** @returns {Promise<Record<string, any>>} */
  async provenanceInfo() {
    return this.provenance();
  }

  /**
   * 应用包摘要（勘察第一跳）。
   * @param {{ path: string }} input
   * @returns {Promise<Record<string, any>>}
   */
  async inspectApp(input) {
    try {
      return await this.actions.inspectAppBundle(input);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * 拿到会话服务后重建 actions（builder 需要 create/prompt/wait）。
   */
  /**
   * createActions 的公共选项（构造函数与 installSessions 必须共用）。
   * @returns {Parameters<typeof createActions>[0]}
   */
  actionOptions() {
    return {
      store: this.store,
      currentProject: this.currentProject,
      dataRoot: this.dataRoot,
      onWaitChange: (/** @type {any} */ state) => {
        this.accessWait = state;
      },
      provenance: () => this.provenance(),
      runner: this.runner,
    };
  }

  installSessions() {
    try {
      this.ctx.inject?.(/** @type {any} */ (["sessionController"]), (/** @type {any} */ scope) => {
        const controller = scope.sessionController;
        if (!controller) return;
        // 注意：这里必须和构造函数用同一份选项——漏掉 onWaitChange 会让
        // 等待登录状态永远不生效（实测踩过：await-login 期间 accessState 恒为 false）。
        this.actions = createActions({
          ...this.actionOptions(),
          sessions: {
            create: async (input) => {
              const created = await controller.create({ cwd: input.cwd });
              return { sessionId: String(created.sessionId) };
            },
            prompt: async (input) => {
              await controller.prompt(
                {
                  requestId: `casefile-${Date.now()}`,
                  sessionId: input.sessionId,
                  mode: "queue",
                  content: [{ type: "text", text: input.text }],
                },
                new AbortController().signal,
              );
            },
            wait: async (input) => {
              const value = await controller.wait(
                { sessionId: input.sessionId, timeoutMs: input.timeoutMs ?? 120_000 },
                new AbortController().signal,
              );
              return { reason: value.reason, output: value.output ?? null };
            },
          },
        });
      });
    } catch (error) {
      this.logger.warn?.(`[casefile] 会话服务不可用（builder 将禁用）：${String(error)}`);
    }
  }

  installTools() {
    try {
      this.ctx.inject?.(/** @type {any} */ (["tools"]), (/** @type {any} */ scope) => {
        scope.effect(() => {
          const definitions = buildToolDefinitions(this.toolHandlers(), (exec) =>
            this.actions.recall(exec),
          );
          const disposers = definitions.map((definition) => scope.tools.register(definition));
          return () => {
            for (const dispose of disposers) {
              if (typeof dispose === "function") dispose();
            }
          };
        }, "casefile: tools");
      });
    } catch (error) {
      this.logger.warn?.(`[casefile] 无法注册工具：${String(error)}`);
    }
  }

  /**
   * 工具用的动作表：在 actions 之上补「打开即记住当前项目」等会话语义。
   * @returns {Record<string, (...args: any[]) => any>}
   */
  toolHandlers() {
    return {
      openProject: (input, exec) => this.actions.openProject(input, exec),
      listProjects: () => this.actions.listProjects(),
      getProject: (projectId) => this.actions.detail(projectId),
      updateProject: (projectId, patch) => this.actions.updateProject(projectId, patch),
      addEvidence: (projectId, input, exec) => this.actions.addEvidence(projectId, input, exec),
      listEvidence: (projectId, filter) => this.actions.listEvidence(projectId, filter),
      showEvidence: (projectId, evidenceId) => this.actions.showEvidence(projectId, evidenceId),
      addClaim: (projectId, input) => this.actions.addClaim(projectId, input),
      listClaims: (projectId, filter) => this.actions.listClaims(projectId, filter),
      searchClaims: (projectId, query) => this.actions.searchClaims(projectId, query),
      selectClaims: (projectId, ids, selected) =>
        this.actions.selectClaims(projectId, ids, selected),
      addFeature: (projectId, input) => this.actions.addFeature(projectId, input),
      listFeatures: (projectId) => this.actions.listFeatures(projectId),
      addUnknown: (projectId, input) => this.actions.addUnknown(projectId, input),
      listUnknowns: (projectId) => this.actions.listUnknowns(projectId),
      resolveUnknown: (projectId, id, note) => this.actions.resolveUnknown(projectId, id, note),
      addObligation: (projectId, input) => this.actions.addObligation(projectId, input),
      listObligations: (projectId) => this.actions.listObligations(projectId),
      addCheck: (projectId, input) => this.actions.addCheck(projectId, input),
      listChecks: (projectId, id) => this.actions.listChecks(projectId, id),
      closeObligation: (projectId, id, input) => this.actions.closeObligation(projectId, id, input),
      reopenObligation: (projectId, id, note) => this.actions.reopenObligation(projectId, id, note),
      overview: () => this.actions.overview(),
      awaitLogin: (projectId, input) => this.actions.awaitLogin(projectId, input),
      accessState: () => this.accessState(),
      provenanceInfo: () => this.provenance(),
      inspectApp: (input) => this.actions.inspectAppBundle(input),
      archiveProject: (projectId, options) => this.actions.archiveProject(projectId, options),
      dropProject: (projectId, options) => this.actions.dropProject(projectId, options),
      runCycle: (projectId, input) => this.actions.runCycle(projectId, input),
      isBuilderSession: (sessionId) =>
        this.store.listBuilderSessions().has(String(sessionId ?? "")),
      closeProject: (projectId, options) => this.actions.closeProject(projectId, options),
      closePreview: (projectId, options) => this.actions.closePreview(projectId, options),
      exportReport: (projectId, options) => this.actions.exportReport(projectId, options),
      advanceLoop: (projectId, input) => this.actions.advanceLoop(projectId, input),
      startBuilder: (projectId, input) => this.actions.startBuilder(projectId, input),
      awaitBuilder: (projectId, input) => this.actions.awaitBuilder(projectId, input),
      startBuild: (projectId, input) => this.actions.startBuild(projectId, input),
      runCheck: (projectId, input) => this.actions.runCheck(projectId, input),
      loopStatus: (projectId, stop) => this.actions.loopStatus(projectId, stop),
      exportSpecPack: (projectId, options) => this.actions.exportSpecPack(projectId, options),
    };
  }

  // ---------- Remote ----------

  /** @returns {Promise<any[]>} */
  async listProjects() {
    try {
      return await this.actions.listProjects();
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async createProject(input) {
    try {
      return await this.actions.openProject(input ?? {});
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @returns {Promise<Record<string, any>>}
   */
  async projectDetail(projectId) {
    try {
      const detail = await this.actions.detail(projectId);
      const runs = await this.actions.loopStatus(projectId).catch(() => null);
      return { ...detail, runs, capabilities: gradeCapabilities(this.capabilities()) };
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} patch
   * @returns {Promise<Record<string, any>>}
   */
  async updateProject(projectId, patch) {
    try {
      return await this.actions.updateProject(projectId, patch);
    } catch (error) {
      fail(error);
    }
  }

  /** @returns {Promise<Record<string, any>>} */
  async diagnose() {
    return this.actions.diagnose(this.capabilities()).catch(fail);
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async addEvidence(projectId, input) {
    try {
      return await this.actions.addEvidence(projectId, input);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} [filter]
   * @returns {Promise<any[]>}
   */
  async listEvidence(projectId, filter) {
    try {
      return await this.actions.listEvidence(projectId, filter);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async addClaim(projectId, input) {
    try {
      return await this.actions.addClaim(projectId, input);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} [filter]
   * @returns {Promise<any[]>}
   */
  async listClaims(projectId, filter) {
    try {
      return await this.actions.listClaims(projectId, filter);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {string} query
   * @returns {Promise<any[]>}
   */
  async searchClaims(projectId, query) {
    try {
      return await this.actions.searchClaims(projectId, query);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {string[]} claimIds
   * @param {boolean} selected
   * @returns {Promise<any[]>}
   */
  async selectClaims(projectId, claimIds, selected) {
    try {
      return await this.actions.selectClaims(projectId, claimIds, selected);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async addFeature(projectId, input) {
    try {
      return await this.actions.addFeature(projectId, input);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @returns {Promise<any[]>}
   */
  async listFeatures(projectId) {
    try {
      return await this.actions.listFeatures(projectId);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async addUnknown(projectId, input) {
    try {
      return await this.actions.addUnknown(projectId, input);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @returns {Promise<any[]>}
   */
  async listUnknowns(projectId) {
    try {
      return await this.actions.listUnknowns(projectId);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {string} unknownId
   * @param {string} [note]
   * @returns {Promise<Record<string, any>>}
   */
  async resolveUnknown(projectId, unknownId, note) {
    try {
      return await this.actions.resolveUnknown(projectId, unknownId, note);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async startBuild(projectId, input) {
    try {
      return await this.actions.startBuild(projectId, /** @type {any} */ (input));
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async runCheck(projectId, input) {
    try {
      return await this.actions.runCheck(projectId, /** @type {any} */ (input));
    } catch (error) {
      fail(error);
    }
  }

  /** @returns {Promise<Record<string, any>>} */
  async overview() {
    try {
      return await this.actions.overview();
    } catch (error) {
      fail(error);
    }
  }

  /** @returns {Promise<Record<string, any>>} */
  async accessState() {
    return this.accessWait == null ? { active: false } : { ...this.accessWait };
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} [options]
   * @returns {Promise<Record<string, any>>}
   */
  async archiveProject(projectId, options) {
    try {
      return await this.actions.archiveProject(projectId, options ?? {});
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} [options]
   * @returns {Promise<Record<string, any>>}
   */
  async dropProject(projectId, options) {
    try {
      return await this.actions.dropProject(projectId, options ?? {});
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async awaitLogin(projectId, input) {
    try {
      return await this.actions.awaitLogin(projectId, /** @type {any} */ (input));
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async runCycle(projectId, input) {
    try {
      return await this.actions.runCycle(projectId, /** @type {any} */ (input));
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} [options]
   * @returns {Promise<Record<string, any>>}
   */
  async closeProject(projectId, options) {
    try {
      return await this.actions.closeProject(projectId, options ?? {});
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {{ format?: "md" | "html" | "both" }} [options]
   * @returns {Promise<Record<string, any>>}
   */
  async exportReport(projectId, options) {
    try {
      return await this.actions.exportReport(projectId, options);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async advanceLoop(projectId, input) {
    try {
      return await this.actions.advanceLoop(projectId, /** @type {any} */ (input));
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async startBuilder(projectId, input) {
    try {
      return await this.actions.startBuilder(projectId, /** @type {any} */ (input));
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async awaitBuilder(projectId, input) {
    try {
      return await this.actions.awaitBuilder(projectId, /** @type {any} */ (input));
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} [stop]
   * @returns {Promise<Record<string, any>>}
   */
  async loopStatus(projectId, stop) {
    try {
      return await this.actions.loopStatus(projectId, stop);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {{ redact?: boolean }} [options]
   * @returns {Promise<Record<string, any>>}
   */
  async exportSpecPack(projectId, options) {
    try {
      return await this.actions.exportSpecPack(projectId, options);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async addObligation(projectId, input) {
    try {
      return await this.actions.addObligation(projectId, input);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @returns {Promise<any[]>}
   */
  async listObligations(projectId) {
    try {
      return await this.actions.listObligations(projectId);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {Record<string, any>} input
   * @returns {Promise<Record<string, any>>}
   */
  async addCheck(projectId, input) {
    try {
      return await this.actions.addCheck(projectId, input);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {string} [obligationId]
   * @returns {Promise<any[]>}
   */
  async listChecks(projectId, obligationId) {
    try {
      return await this.actions.listChecks(projectId, obligationId);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {string} obligationId
   * @param {{ checkId?: string, note?: string }} [input]
   * @returns {Promise<Record<string, any>>}
   */
  async closeObligation(projectId, obligationId, input) {
    try {
      return await this.actions.closeObligation(projectId, obligationId, input);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * @param {string} projectId
   * @param {string} obligationId
   * @param {string} [note]
   * @returns {Promise<Record<string, any>>}
   */
  async reopenObligation(projectId, obligationId, note) {
    try {
      return await this.actions.reopenObligation(projectId, obligationId, note);
    } catch (error) {
      fail(error);
    }
  }
}

declareRemote(CasefileService, "listProjects");
declareRemote(CasefileService, "createProject");
declareRemote(CasefileService, "projectDetail");
declareRemote(CasefileService, "updateProject");
declareRemote(CasefileService, "diagnose");
declareRemote(CasefileService, "addEvidence");
declareRemote(CasefileService, "listEvidence");
declareRemote(CasefileService, "addClaim");
declareRemote(CasefileService, "listClaims");
declareRemote(CasefileService, "searchClaims");
declareRemote(CasefileService, "selectClaims");
declareRemote(CasefileService, "addFeature");
declareRemote(CasefileService, "listFeatures");
declareRemote(CasefileService, "addUnknown");
declareRemote(CasefileService, "listUnknowns");
declareRemote(CasefileService, "resolveUnknown");
declareRemote(CasefileService, "addObligation");
declareRemote(CasefileService, "listObligations");
declareRemote(CasefileService, "addCheck");
declareRemote(CasefileService, "listChecks");
declareRemote(CasefileService, "closeObligation");
declareRemote(CasefileService, "reopenObligation");
declareRemote(CasefileService, "overview");
declareRemote(CasefileService, "accessState");
declareRemote(CasefileService, "inspectApp");
declareRemote(CasefileService, "provenanceInfo");
declareRemote(CasefileService, "archiveProject");
declareRemote(CasefileService, "dropProject");
declareRemote(CasefileService, "awaitLogin");
declareRemote(CasefileService, "runCycle");
declareRemote(CasefileService, "closeProject");
declareRemote(CasefileService, "exportReport");
declareRemote(CasefileService, "advanceLoop");
declareRemote(CasefileService, "startBuilder");
declareRemote(CasefileService, "awaitBuilder");
declareRemote(CasefileService, "startBuild");
declareRemote(CasefileService, "runCheck");
declareRemote(CasefileService, "loopStatus");
declareRemote(CasefileService, "exportSpecPack");
