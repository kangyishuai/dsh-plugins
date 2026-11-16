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
            enum: ["open", "list", "get", "update"],
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
        },
        required: ["action"],
      },
      output: { schema: TOOL_OUTPUT_SCHEMA, render: renderToolResult },
      /** @param {any} args @param {any} exec */
      async execute(args, exec) {
        return run(async () => {
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
            case "get": {
              const project = await handlers.getProject(projectId(args, exec));
              return { project, summary: `项目 ${project.id}（${project.title}）` };
            }
            case "update": {
              const project = await handlers.updateProject(projectId(args, exec), args.patch ?? {});
              return { project, summary: `已更新项目 ${project.id}` };
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
              sourceTool: { type: "string", description: "产出该证据的 REA 工具名" },
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
