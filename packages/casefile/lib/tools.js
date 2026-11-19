// @ts-check
// tools.js：模型可调用的 6 个 casefile 工具。
//
// 设计（spec/02-architecture.md §5.2）：
//   - 工具面控制在个位数；长尾（反编译、抓包、对比）走 REA 自己的工具；
//   - 统一输出 { ok, data | error{code,message,hint}, summary }：错误不抛异常，
//     让模型读到稳定错误码并自行纠正；
//   - 每个工具都接受 projectId；省略时用「本会话最近打开的项目」（由 service 维护）。

import { renderToolResult, TOOL_OUTPUT_SCHEMA } from "./tool-schema.js";

/** 六个工具名（文档、测试、冒烟共用）。 */
export const TOOL_NAMES = /** @type {const} */ ({
  project: "case_project",
  evidence: "case_evidence",
  claim: "case_claim",
  feature: "case_feature",
  unknown: "case_unknown",
  obligation: "case_obligation",
  access: "case_access",
  app: "case_app",
  build: "case_build",
  check: "case_check",
  brief: "case_brief",
});

const PROJECT_ID = {
  type: "string",
  description: "项目 id；省略时使用本会话最近打开的项目",
};

/**
 * 把内部异常映射成稳定的工具错误（错误码 → 文案 + 修复提示）。
 * @param {unknown} error
 * @returns {{ ok: false, error: { code: string, message: string, hint?: string } }}
 */
export function toToolError(error) {
  const anyError = /** @type {any} */ (error);
  const code = typeof anyError?.code === "string" ? anyError.code : "internal";
  const message = String(anyError?.message ?? error ?? "unknown error");
  /** @type {Record<string, string>} */
  const hints = {
    "project-not-found": "先调用 case_project 的 open 或 list 确认项目 id。",
    "project-exists": "换个标题，或直接 open 已有项目。",
    "invalid-input": "按参数 description 修正字段。",
    "read-only-newer": "项目文件由更新的 casefile 写入；升级插件后再试。",
    "no-data-root": "检查插件 Config 里的 dataRoot。",
    "bad-project-id": "项目 id 必须是小写 kebab-case。",
  };
  return { ok: false, error: { code, message, ...(hints[code] ? { hint: hints[code] } : {}) } };
}

/**
 * @param {() => Promise<any> | any} fn
 * @returns {Promise<Record<string, any>>}
 */
async function run(fn) {
  try {
    const data = await fn();
    return { ok: true, ...data };
  } catch (error) {
    return toToolError(error);
  }
}

/**
 * 校验 action 在允许集合内。
 * @param {unknown} action
 * @param {readonly string[]} allowed
 * @returns {string}
 */
function assertAction(action, allowed) {
  const value = String(action ?? "");
  if (!allowed.includes(value)) {
    throw Object.assign(new Error(`未知 action：${value}（允许 ${allowed.join(" | ")}）`), {
      code: "invalid-input",
    });
  }
  return value;
}

/**
 * 生成工具定义。
 * @param {Record<string, Function>} handlers service 提供的动作实现
 * @param {(exec: any) => string | undefined} projectOf 取「本会话最近项目」
 * @returns {any[]}
 */
export function buildToolDefinitions(handlers, projectOf) {
  /**
   * @param {any} args
   * @param {any} exec
   * @returns {string}
   */
  /**
   * builder 子会话只该收到规格包，不得写账本。
   * 写类工具在开跑前统一过这道门：exec.agent.id 命中 builder 登记就拒绝。
   * @param {any} exec
   * @returns {Promise<void>}
   */
  /**
   * builder 子会话只该收到规格包，不得写账本。
   * @param {any} exec
   * @returns {Promise<void>}
   */
  const assertWriter = async (exec) => {
    const sessionId = exec?.agent?.id;
    if (typeof sessionId !== "string" || sessionId === "") return;
    const lookup = handlers.isBuilderSession;
    if (typeof lookup !== "function") return;
    if (await lookup(sessionId)) {
      throw Object.assign(
        new Error("builder 会话不能写案卷：它只该收到规格包。写证据/结论/义务请在主线会话里做。"),
        { code: "builder-readonly" },
      );
    }
  };

  /**
   * @param {any} args
   * @param {any} exec
   * @returns {string}
   */
  const projectId = (args, exec) => {
    const explicit = typeof args.projectId === "string" && args.projectId !== "";
    const id = explicit ? args.projectId : projectOf(exec);
    if (typeof id !== "string" || id === "") {
      throw Object.assign(new Error("还没有指定项目：先 case_project open，或显式传 projectId"), {
        code: "project-not-found",
      });
    }
    return id;
  };

  return [
    {
      name: TOOL_NAMES.project,
      description:
        "casefile 项目：open 新建/打开调查目标，list 列出，get 看详情，update 改授权档/范围/状态。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: [
              "open",
              "list",
              "get",
              "update",
              "close",
              "report",
              "overview",
              "archive",
              "drop",
            ],
            description: "要执行的动作",
          },
          projectId: PROJECT_ID,
          title: { type: "string", description: "open 时必填：项目标题" },
          id: { type: "string", description: "open 时可指定 kebab-case 项目 id" },
          target: {
            type: "object",
            additionalProperties: false,
            description: "open 时描述目标",
            properties: {
              kind: { type: "string", enum: ["binary", "web", "app", "game", "artifact", "other"] },
              ref: { type: "string", description: "路径、URL 或 artifact 标识" },
              note: { type: "string" },
            },
          },
          authTier: { type: "string", enum: ["owned", "authorized", "research"] },
          scope: { type: "string", enum: ["all", "selected"] },
          patch: { type: "object", description: "update 时的字段（title/authTier/scope/state）" },
          minCoverage: { type: "number", description: "close 时的覆盖率下限（默认 1）" },
          reason: { type: "string", description: "archive 时的原因（进审计）" },
          confirm: {
            type: "boolean",
            description: "drop 时必须传 true：把整个项目目录移进 trash（可手动移回）",
          },
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
          await assertWriter(exec);
          switch (args.action) {
            case "open": {
              if (typeof args.title !== "string" || args.title.trim() === "") {
                throw Object.assign(new Error("open 需要 title"), { code: "invalid-input" });
              }
              const project = await handlers.openProject(
                {
                  title: args.title,
                  id: args.id,
                  target: args.target,
                  authTier: args.authTier,
                  scope: args.scope,
                },
                exec,
              );
              return { project, summary: `已打开项目 ${project.id}（${project.title}）` };
            }
            case "list": {
              const projects = await handlers.listProjects();
              return { projects, summary: `${projects.length} 个项目` };
            }
            case "overview": {
              const overview = await handlers.overview();
              return overview;
            }
            case "get": {
              const project = await handlers.getProject(projectId(args, exec));
              return { project, summary: `项目 ${project.id}（${project.title}）` };
            }
            case "update": {
              const project = await handlers.updateProject(projectId(args, exec), args.patch ?? {});
              return { project, summary: `已更新项目 ${project.id}` };
            }
            case "close": {
              const id = projectId(args, exec);
              // 先给只读预览再关：被闸门拒绝时把卡点原样带回去，别只说"失败"
              const preview = await handlers.closePreview(id, { minCoverage: args.minCoverage });
              if (preview.ok !== true) {
                throw Object.assign(new Error(`项目还不能关闭：${preview.blockers.join("、")}`), {
                  code: "coverage-not-met",
                  blockers: preview.blockers,
                });
              }
              const closed = await handlers.closeProject(id, { minCoverage: args.minCoverage });
              return {
                closed: closed.project,
                coverage: preview.coverage,
                summary: `项目已关闭（覆盖率 ${(preview.coverage.ratio * 100).toFixed(0)}%）`,
              };
            }
            case "archive": {
              const archived = await handlers.archiveProject(projectId(args, exec), {
                reason: args.reason,
              });
              return { project: archived.project, summary: `项目已归档：${archived.project.id}` };
            }
            case "drop": {
              const dropped = await handlers.dropProject(projectId(args, exec), {
                confirm: args.confirm,
              });
              return {
                trashedTo: dropped.trashedTo,
                summary: `项目已移入 trash：${dropped.trashedTo}`,
              };
            }
            case "report": {
              return handlers.exportReport(projectId(args, exec));
            }
            default:
              throw Object.assign(new Error(`未知 action：${String(args.action)}`), {
                code: "invalid-input",
              });
          }
        });
      },
    },

    {
      name: TOOL_NAMES.evidence,
      description:
        "证据：add 把一条 REA 观察写成证据（保留 confidence/authority/limitations），list 过滤，show 看单条。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["add", "list", "show"] },
          projectId: PROJECT_ID,
          evidenceId: { type: "string" },
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string" },
              sourceTool: {
                type: "string",
                description:
                  "产出该证据的工具标识（REA 工具名，或外部工具如 scrapling/StealthyFetcher）",
              },
              artifactPath: {
                type: "string",
                description:
                  "可选：把外部采集产物（HTML/HAR/截图）归档进项目目录并记录 sha256；/tmp 产物会被清理，归档后才能长期复算",
              },
              producer: {
                type: "object",
                additionalProperties: false,
                description:
                  "外部证据的生产者：谁采的、什么方式采的。casefile 不采集也不规避访问控制，责任归操作者。",
                properties: {
                  tool: { type: "string" },
                  version: { type: "string" },
                  mode: {
                    type: "string",
                    enum: ["headful", "headless", "api", "archive", "manual", "stealth", "unknown"],
                  },
                  outputKind: { type: "string" },
                  accessConfirmedByUser: { type: "boolean" },
                  confirmationNote: { type: "string" },
                },
              },
              summary: { type: "string", description: "一句话结论" },
              confidence: { type: "string", enum: ["observed", "derived", "inferred"] },
              authority: {
                type: "string",
                enum: ["shipped-artifact", "controlled-replay", "live-observation", "external"],
              },
              limitations: { type: "array", items: { type: "string" } },
              refs: { type: "array", items: { type: "string" } },
              integrity: { type: "string" },
            },
            required: ["summary"],
          },
          filter: {
            type: "object",
            additionalProperties: false,
            properties: { kind: { type: "string" }, confidence: { type: "string" } },
          },
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
          await assertWriter(exec);
          const action = assertAction(args.action, ["add", "list", "show"]);
          const id = projectId(args, exec);
          if (action === "add") {
            const evidence = await handlers.addEvidence(id, args.input ?? {}, exec);
            return { evidence, summary: `已记录证据 ${evidence.id}` };
          }
          if (action === "show") {
            const evidence = await handlers.showEvidence(id, String(args.evidenceId ?? ""));
            return { evidence, summary: `证据 ${evidence.id}` };
          }
          const evidence = await handlers.listEvidence(id, args.filter);
          return { evidence, summary: `${evidence.length} 条证据` };
        });
      },
    },

    {
      name: TOOL_NAMES.claim,
      description:
        "结论：add 写一条可引用结论（引用 evidenceIds），list/search 查，select 勾选/取消进入规格包。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["add", "list", "search", "select"] },
          projectId: PROJECT_ID,
          query: { type: "string", description: "search 的关键词" },
          claimIds: { type: "array", items: { type: "string" } },
          selected: { type: "boolean" },
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              kind: { type: "string" },
              status: { type: "string", enum: ["observed", "derived", "inferred"] },
              limitations: { type: "array", items: { type: "string" } },
              evidenceIds: { type: "array", items: { type: "string" } },
              featureIds: { type: "array", items: { type: "string" } },
            },
            required: ["text"],
          },
          filter: {
            type: "object",
            additionalProperties: false,
            properties: {
              selected: { type: "boolean" },
              featureId: { type: "string" },
              status: { type: "string" },
            },
          },
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
          await assertWriter(exec);
          const action = assertAction(args.action, ["add", "list", "search", "select"]);
          const id = projectId(args, exec);
          if (action === "add") {
            const claim = await handlers.addClaim(id, args.input ?? {});
            return { claim, summary: `已记录结论 ${claim.id}` };
          }
          if (action === "search") {
            const claims = await handlers.searchClaims(id, String(args.query ?? ""));
            return { claims, summary: `命中 ${claims.length} 条结论` };
          }
          if (action === "select") {
            const claims = await handlers.selectClaims(
              id,
              Array.isArray(args.claimIds) ? args.claimIds : [],
              args.selected !== false,
            );
            return { claims, summary: `已更新 ${claims.length} 条结论` };
          }
          const claims = await handlers.listClaims(id, args.filter);
          return { claims, summary: `${claims.length} 条结论` };
        });
      },
    },

    {
      name: TOOL_NAMES.feature,
      description: "功能分组：add 建一个功能并把若干结论归到它下面，list 列出。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["add", "list"] },
          projectId: PROJECT_ID,
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              summary: { type: "string" },
              claimIds: { type: "array", items: { type: "string" } },
              boundaries: { type: "array", items: { type: "string" } },
              nonGoals: { type: "array", items: { type: "string" } },
            },
            required: ["name"],
          },
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
          await assertWriter(exec);
          const action = assertAction(args.action, ["add", "list"]);
          const id = projectId(args, exec);
          if (action === "add") {
            const feature = await handlers.addFeature(id, args.input ?? {});
            return { feature, summary: `已建功能 ${feature.id}（${feature.name}）` };
          }
          const features = await handlers.listFeatures(id);
          return { features, summary: `${features.length} 个功能` };
        });
      },
    },

    {
      name: TOOL_NAMES.unknown,
      description: "未知项：add 记录，list 列出，resolve 标记已解决（会随规格包一起交付）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["add", "list", "resolve"] },
          projectId: PROJECT_ID,
          unknownId: { type: "string" },
          note: { type: "string" },
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              severity: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["text"],
          },
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
          await assertWriter(exec);
          const action = assertAction(args.action, ["add", "list", "resolve"]);
          const id = projectId(args, exec);
          if (action === "add") {
            const unknown = await handlers.addUnknown(id, args.input ?? {});
            return { unknown, summary: `已记录未知项 ${unknown.id}` };
          }
          if (action === "resolve") {
            const unknown = await handlers.resolveUnknown(
              id,
              String(args.unknownId ?? ""),
              args.note,
            );
            return { unknown, summary: `未知项 ${unknown.id} → ${unknown.status}` };
          }
          const unknowns = await handlers.listUnknowns(id);
          return { unknowns, summary: `${unknowns.length} 个未知项` };
        });
      },
    },

    {
      name: TOOL_NAMES.obligation,
      description:
        "义务：add 加一条可验收义务，list 列出，close 关闭（必须有新鲜 PASS 检查，否则拒绝），reopen 重开。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["add", "list", "close", "reopen"] },
          projectId: PROJECT_ID,
          obligationId: { type: "string" },
          checkId: { type: "string", description: "close 时可指定某条检查结果" },
          note: { type: "string" },
          input: {
            type: "object",
            additionalProperties: false,
            properties: {
              statement: { type: "string" },
              kind: {
                type: "string",
                enum: ["existence", "structure", "behavior", "visual", "coverage", "regression"],
              },
              source: { type: "string" },
              authorityRequired: {
                type: "string",
                enum: ["controlled-replay", "live-observation", "external"],
              },
              ownerDigest: { type: "string" },
              evidenceIds: { type: "array", items: { type: "string" } },
              featureIds: {
                type: "array",
                items: { type: "string" },
                description: "挂到哪些功能上（用于按功能覆盖率）",
              },
            },
            required: ["statement"],
          },
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
          await assertWriter(exec);
          const action = assertAction(args.action, ["add", "list", "close", "reopen"]);
          const id = projectId(args, exec);
          if (action === "add") {
            const obligation = await handlers.addObligation(id, args.input ?? {});
            return { obligation, summary: `已加义务 ${obligation.id}` };
          }
          if (action === "close") {
            const obligation = await handlers.closeObligation(id, String(args.obligationId ?? ""), {
              checkId: args.checkId,
              note: args.note,
            });
            return { obligation, summary: `义务 ${obligation.id} → ${obligation.status}` };
          }
          if (action === "reopen") {
            const obligation = await handlers.reopenObligation(
              id,
              String(args.obligationId ?? ""),
              args.note,
            );
            return { obligation, summary: `义务 ${obligation.id} → ${obligation.status}` };
          }
          const obligations = await handlers.listObligations(id);
          return { obligations, summary: `${obligations.length} 条义务` };
        });
      },
    },

    {
      name: TOOL_NAMES.access,
      description:
        "访问协助：await-login 轮询等人完成登录（带超时，就绪/超时/错误三态，不假装成功）。用于登录态页面采集前。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["await-login"] },
          projectId: PROJECT_ID,
          endpoint: { type: "string", description: "CDP 端点，形如 http://127.0.0.1:9223" },
          urlPrefix: { type: "string", description: "只选 URL 以它开头的页面" },
          readyJs: {
            type: "string",
            description: "就绪判据（返回 boolean 的 JS 表达式），默认「页面里没有密码输入框」",
          },
          pollMs: { type: "integer", description: "轮询间隔，默认 2000" },
          timeoutMs: { type: "integer", description: "最长等待，默认 180000（3 分钟）" },
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
          await assertWriter(exec);
          assertAction(args.action, ["await-login"]);
          const id = projectId(args, exec);
          const result = await handlers.awaitLogin(id, {
            endpoint: args.endpoint,
            urlPrefix: args.urlPrefix,
            readyJs: args.readyJs,
            pollMs: args.pollMs,
            timeoutMs: args.timeoutMs,
          });
          return {
            ...result,
            summary:
              result.status === "ready"
                ? `已就绪（等了 ${result.waitedMs}ms，${result.attempts} 次探测）`
                : `${result.status}：${result.hint}`,
          };
        });
      },
    },

    {
      name: TOOL_NAMES.app,
      description:
        "应用勘察第一跳：inspect 读 macOS .app 的 Info.plist 与可执行架构，一次给出一屏摘要（bundle id/版本/沙盒/ATS/URL scheme/UTI 归属），并可选写入一条证据。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["inspect"] },
          projectId: PROJECT_ID,
          path: { type: "string", description: "绝对路径，形如 /Applications/Foo.app" },
          record: {
            type: "boolean",
            description: "默认 true：把摘要写成一条结构证据（authority=shipped-artifact）",
          },
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
          await assertWriter(exec);
          assertAction(args.action, ["inspect"]);
          if (typeof args.path !== "string" || args.path.trim() === "") {
            throw Object.assign(new Error("inspect 需要 path（形如 /Applications/Foo.app）"), {
              code: "invalid-input",
            });
          }
          const summary = await handlers.inspectApp({ path: args.path });
          const id = args.record === false ? null : projectId(args, exec);
          let evidence = null;
          if (id != null) {
            evidence = await handlers.addEvidence(
              id,
              {
                kind: "structure",
                authority: "shipped-artifact",
                confidence: "observed",
                summary: `应用包摘要（${summary.bundleId ?? "未知 bundle id"}）：版本 ${summary.shortVersion ?? "?"}（build ${summary.buildVersion ?? "?"}）、架构 ${(summary.architectures ?? []).join("/") || "未知"}、沙盒 ${summary.sandboxed === true ? "是" : summary.sandboxed === false ? "否" : "未声明"}、ATS 任意加载 ${summary.allowsArbitraryLoads === true ? "开启" : "关闭/未声明"}、UTI 域一致性 ${summary.domainConsistency?.consistent === true ? "一致" : summary.domainConsistency?.consistent === false ? "不一致" : "无法判断"}`,
                limitations: [
                  "只读 Info.plist 与可执行架构；plist 声明不等于运行时行为",
                  "未校验签名有效性，未进入二进制本体",
                ],
                refs: [String(args.path)],
                producer: {
                  tool: "casefile/app-bundle",
                  version: "1",
                  mode: "archive",
                  outputKind: "json-summary",
                  accessConfirmedByUser: true,
                  confirmationNote: "读取本机已安装应用包的静态信息（plutil/lipo），未执行该应用",
                },
              },
              exec,
            );
          }
          return {
            summary: `应用：${summary.bundleId ?? "?"} · ${summary.shortVersion ?? "?"} · ${(summary.architectures ?? []).join("/") || "架构未知"}`,
            app: summary,
            evidenceId: evidence?.id ?? null,
          };
        });
      },
    },

    {
      name: TOOL_NAMES.build,
      description:
        "构建：cycle 跑端到端一轮（可选 builder → 构建 → 检查 → 关闭）；start 跑命令并落 BuildRun；agent 起 builder 会话或 await 等它停下；loop 多轮自动循环；status 看轮次与停止条件。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["start", "status", "agent", "loop", "cycle"] },
          projectId: PROJECT_ID,
          prompt: { type: "string", description: "agent 时可选：给 builder 的额外指令" },
          allowResearchTier: {
            type: "boolean",
            description: "授权档是 research 时，确认有权复刻后显式放行（会写审计）",
          },
          reason: { type: "string", description: "放行 research 档的理由（进审计）" },
          featureIds: { type: "array", items: { type: "string" } },
          sessionId: { type: "string", description: "await 用：builder 会话 id" },
          command: { type: "string", description: "start 时必填：构建命令（shell）" },
          cwd: { type: "string", description: "构建目录；给了才会算实现 digest" },
          round: { type: "integer", description: "可选：指定轮次，默认自动递增" },
          maxRounds: { type: "integer", description: "loop 最多跑几轮（默认 1）" },
          timeoutMs: { type: "integer" },
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
          await assertWriter(exec);
          const action = assertAction(args.action, ["start", "status", "agent", "loop", "cycle"]);
          const id = projectId(args, exec);
          if (action === "cycle") {
            // 只有显式要求 builder（prompt 或 featureIds）才起会话；
            // cwd 是构建目录，单独给 cwd 不应该顺手启动一个 builder 子会话。
            const wantsBuilder = args.prompt !== undefined || args.featureIds !== undefined;
            const result = await handlers.runCycle(id, {
              builder: wantsBuilder
                ? {
                    cwd: args.cwd,
                    prompt: args.prompt,
                    featureIds: args.featureIds,
                    timeoutMs: args.timeoutMs,
                  }
                : undefined,
              command: args.command,
              cwd: args.cwd,
              maxRounds: args.maxRounds,
              timeoutMs: args.timeoutMs,
            });
            return result;
          }
          if (action === "loop") {
            const result = await handlers.advanceLoop(id, {
              command: args.command,
              cwd: args.cwd,
              maxRounds: args.maxRounds,
              timeoutMs: args.timeoutMs,
            });
            return result;
          }
          if (action === "agent") {
            if (args.sessionId) {
              const awaited = await handlers.awaitBuilder(id, {
                sessionId: args.sessionId,
                timeoutMs: args.timeoutMs,
              });
              return { ...awaited, summary: `builder ${awaited.reason}` };
            }
            const started = await handlers.startBuilder(id, {
              cwd: args.cwd,
              prompt: args.prompt,
              featureIds: args.featureIds,
              allowResearchTier: args.allowResearchTier,
              reason: args.reason,
            });
            return {
              ...started,
              summary: `已起 builder 会话 ${started.builder.sessionId}（投喂 ${started.builder.claims} 条结论）`,
            };
          }
          if (action === "start") {
            if (typeof args.command !== "string" || args.command.trim() === "") {
              throw Object.assign(new Error("start 需要 command"), { code: "invalid-input" });
            }
            const result = await handlers.startBuild(id, {
              command: args.command,
              cwd: args.cwd,
              round: args.round,
              timeoutMs: args.timeoutMs,
            });
            return {
              ...result,
              summary: `第 ${result.build.round} 轮构建：${result.build.status}（实现 ${result.build.implementationDigest ? "已算" : "未算"}，重开 ${result.stale.length} 条义务）`,
            };
          }
          const status = await handlers.loopStatus(id);
          return {
            ...status,
            summary: `构建 ${status.builds} 轮 / 检查 ${status.checks} / 停止条件 ${status.stop.reason}`,
          };
        });
      },
    },

    {
      name: TOOL_NAMES.check,
      description:
        "验收：run 跑一条 checker（build/cli/web/process/selfTest）并把结果绑定到当前构建的实现 digest；list 看历史；loop 看停止条件。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["run", "list", "loop"] },
          projectId: PROJECT_ID,
          obligationId: { type: "string" },
          checker: { type: "string", enum: ["build", "cli", "web", "process", "selfTest"] },
          jsonPath: { type: "string", description: "selfTest：报告 JSON 路径（默认读 stdout）" },
          reference: { type: "string", description: "web：原件截图路径" },
          candidate: { type: "string", description: "web：候选截图路径" },
          minSimilarity: { type: "number", description: "web：相似度阈值（默认 0.98）" },
          allowSizeMismatch: { type: "boolean" },
          command: { type: "string" },
          cwd: { type: "string" },
          expect: {
            type: "object",
            description: "cli 期望：{ exitCode?, stdoutIncludes?, stdoutEquals?, stderrIncludes? }",
          },
          timeoutMs: { type: "integer" },
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
          await assertWriter(exec);
          const action = assertAction(args.action, ["run", "list", "loop"]);
          const id = projectId(args, exec);
          if (action === "run") {
            const result = await handlers.runCheck(id, {
              obligationId: args.obligationId,
              checker: args.checker ?? "cli",
              command: args.command,
              cwd: args.cwd,
              expect: args.expect,
              timeoutMs: args.timeoutMs,
              reference: args.reference,
              candidate: args.candidate,
              minSimilarity: args.minSimilarity,
              allowSizeMismatch: args.allowSizeMismatch,
              jsonPath: args.jsonPath,
            });
            return {
              ...result,
              summary: `检查 ${result.check.id}：${result.check.verdict}`,
            };
          }
          if (action === "list") {
            const detail = await handlers.getProject(id);
            return {
              checks: detail.checks ?? [],
              summary: `${(detail.checks ?? []).length} 条检查`,
            };
          }
          const status = await handlers.loopStatus(id);
          return { ...status, summary: `停止条件：${status.stop.reason}` };
        });
      },
    },

    {
      name: TOOL_NAMES.brief,
      description:
        "导出规格包：把「选中的结论 + 它们的证据 + 未知项」写成 spec.json 与 brief.md，默认脱敏。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["export"] },
          projectId: PROJECT_ID,
          redact: { type: "boolean", description: "是否脱敏（默认 true）" },
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
          assertAction(args.action, ["export"]);
          const id = projectId(args, exec);
          const result = await handlers.exportSpecPack(id, { redact: args.redact !== false });
          return result;
        });
      },
    },
  ];
}
