#!/usr/bin/env node
// @ts-check
// 用法：pnpm probe:runtime [--asar <path>] [--surface <node_modules 目录>] [--json]
//
// DSH 升级前/后的体检：直接解析 app.asar 的目录索引（或 npm 装出来的宿主 surface 目录），
// 核对本仓库插件依赖的宿主包、API、服务、私有 seam 与 slot 是否还在。
// 不启动宿主、不改任何文件。
//
// 两种宿主面：
//   --asar <path>       macOS 桌面版的 app.asar（默认路径，本机开发用）。
//   --surface <dir>     npm 装出来的 node_modules（CI 用；`node scripts/prepare-dsh-surface.mjs`
//                       会按 `AGENTS.md` 的目标运行时版本从 npm 装一份）。传目录本身或其父目录
//                       （自动找 `<dir>/node_modules/@deepseek-ai`）。
// 显式给了路径但不存在 → exit 2（CI 里必须红，不能把「没装」当「通过」）。
// 既没 --asar/--surface、默认 asar 也不存在 → 打印 SKIP 并 exit 0（只适用于本地开发机）。
import { existsSync } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isMain } from "./lib/repo.mjs";

const DEFAULT_ASAR = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";

/**
 * 宿主面（asar 或 npm 目录）统一抽象：虚拟路径都是 `/dsh/node_modules/...`。
 * asar 条目带 offset；目录条目带绝对 path。
 * @typedef {{ offset?: number, path?: string, size: number }} SurfaceEntry
 * @typedef {object} Surface
 * @property {"asar" | "npm"} kind
 * @property {string} path
 * @property {Map<string, SurfaceEntry>} files
 * @property {(path: string) => Promise<Buffer | undefined>} read
 * @property {() => Promise<void>} close
 */

/** 视为必需（缺失即 FAIL）的宿主包。 */
const REQUIRED_PACKAGES = [
  "dsh-session-persistence",
  "dsh-session-persistence-jsonl",
  "dsh-workspace",
  "dsh-session",
  "dsh-typert-protocol",
  "dsh-api-gateway",
];

/** 按文件检查的 API 面。pattern 缺失即 FAIL。 */
const API_CHECKS = [
  {
    file: "@deepseek-ai/dsh-session-persistence/lib/index.js",
    name: "sessionPersistence 服务定义",
    pattern: /class SessionPersistence|open\(id|SessionAlreadyOwnedError/u,
  },
  {
    file: "@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js",
    name: "JSONL 后端 locate()（取真实路径）",
    pattern: /locate\s*\(/u,
  },
  {
    file: "@deepseek-ai/dsh-workspace/lib/index.js",
    name: "workspaceRegistry.archiveSession / unarchiveSession",
    pattern: /archiveSession\s*\(/u,
  },
  {
    file: "@deepseek-ai/dsh-workspace/lib/index.js",
    name: "workspaceRegistry.pinSession / unpinSession",
    pattern: /unpinSession\s*\(/u,
  },
  {
    file: "@deepseek-ai/dsh-session/lib/index.js",
    name: "sessions.detachEntered（社区契约，用于摘 live 条目）",
    pattern: /detachEntered/u,
    optional: true,
  },
  {
    file: "@deepseek-ai/dsh-typert-protocol/lib/index.js",
    name: "TypertRemoteService / Remote（host 服务注册）",
    pattern: /TypertRemoteService/u,
  },
  {
    file: "@deepseek-ai/dsh-session/lib/index.js",
    name: "session surface replace / deriveEventMessage（回溯 marker 依赖）",
    pattern: /surfaceOp/u,
  },
  {
    file: "@deepseek-ai/dsh-session/lib/index.js",
    name: "session.deriveMessages / surface（可见性/幽灵历史依赖）",
    pattern: /deriveMessages\s*\(/u,
  },
  {
    file: "@deepseek-ai/dsh-session/lib/index.js",
    name: "session.append（追加 marker 的唯一写入口）",
    pattern: /append\(type, data/u,
  },
  {
    file: "@deepseek-ai/dsh-tools/lib/pipeline.js",
    name: "tools/execute / tools/post-execute / tools/result 工具钩子",
    pattern: /tools\/execute[\s\S]*tools\/post-execute[\s\S]*tools\/result/u,
  },
  {
    file: "@deepseek-ai/dsh-tool-fs/lib/index.js",
    name: "write / edit / apply_patch 工具（文件追踪范围）",
    pattern: /name: "write"[\s\S]*name: "apply_patch"/u,
  },
  {
    file: "@deepseek-ai/dsh-tool-fs/lib/index.js",
    name: "文件工具结果携带 before/after（写前快照依赖）",
    pattern: /before[\s\S]{0,200}after/u,
  },
  {
    file: "@deepseek-ai/dsh-client-ui-renderer/lib/client.js",
    name: "client slots 服务（SlotRegistry）",
    pattern: /super\(\s*ctx,\s*[`"']slots[`"']/u,
  },
  {
    file: "@deepseek-ai/dsh-client-ui-commands/lib/client.js",
    name: "commandUi.decorate（/rewind 命令装饰）",
    pattern: /decorate\(decoration\)/u,
  },
  {
    file: "@deepseek-ai/dsh-token-meter/lib/types/estimate.js",
    name: "estimateMessage（预览 token 估算）",
    pattern: /export function estimateMessage/u,
  },
];

/**
 * 本仓库插件实际依赖的**私有 seam**（不是公开 API，随时可能变）。
 * 每条都写清「如果它没了，哪个功能会坏」——升级时先看这里。
 *
 * 匹配 client 源码时注意：0.2.2-rc.2 起 `lib/client.js` 是压缩产物，字符串可能改用
 * 反引号、逗号后不留空格；0.2.2-rc.1 及更早则是未压缩、双引号。所以字符串一律写成
 * [`"'] 字符类 + `\s*`，不要写死双引号或空格，否则升级会误报 FAIL。
 *
 * 定位文件时：固定路径用 `file`；文件名带内容哈希的产物（web-frontend 的
 * `dist/assets/index-<hash>.js`）必须用 `filePattern` 扫——哈希每个版本都变，
 * 写死会让探针每次升级都误报（rc.3 实测：`index-ghOpC9uV.js` → `index-Ciz7DZxv.js`）。
 */
const SEAM_CHECKS = [
  {
    file: "@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
    name: "uiConversation.views（target/create 可替换）",
    pattern: /entries\s*\(\)/u,
    breaks: "回溯后把被撤回的行从对话里隐藏（只剩日志层面撤回）",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
    name: "uiConversation.views.subscribe",
    pattern: /subscribe\s*[(:]/u,
    breaks: "视图定义变化后重新接管（新开会话时隐藏可能失效）",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-chat/lib/client.js",
    name: "chat builder 支持 visibility 字段",
    pattern: /visibility/u,
    breaks: "被撤回行的隐藏渲染（模型上下文仍然正确，但界面会照常显示）",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-chat/lib/client.js",
    name: "消息行 extraActions 槽位（↶ 按钮注入点）",
    pattern: /extraActions/u,
    breaks: "每条用户消息旁的 ↶ 按钮",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-chat/lib/client.js",
    name: 'conversation.chat.node 以 key: "user" 注册（按 user 行接管）',
    pattern: /conversation\.chat\.node[\s\S]{0,300}key:\s*[`"']user[`"']/u,
    breaks: "↶ 按钮注入（接管不到 user 行构造）",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
    name: "conversation.input.for(actx) facade",
    pattern: /for\s*\(\s*actx\s*\)/u,
    breaks: "回溯后回填输入框 / 回退后立即重发",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
    name: "输入框 setDraft + submit('queue')",
    pattern: /setDraft\s*\(/u,
    breaks: "回填草稿与一键重发",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
    name: "输入框附件通道（addAttachments / createDrafts）",
    pattern: /addAttachments/u,
    breaks: "回溯后被撤回消息里的图片重新挂回输入框",
  },
  {
    file: "@deepseek-ai/dsh-client-shortcuts/lib/client.js",
    name: "shortcuts.registerFixed（Esc Esc 固定快捷键）",
    pattern: /registerFixed/u,
    breaks: "Esc Esc 打开回溯对话框（↶ 按钮与 /rewind 仍在）",
  },
  {
    file: "@deepseek-ai/dsh-client-shortcuts/lib/client.js",
    name: "shortcuts.observeFixedInput（每个 keydown 都会送达观察者）",
    pattern: /observeFixedInput/u,
    breaks: "Esc Esc 只在空闲会话生效（可能抢内置停止）；输入框 ↑/↓ 召回",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
    name: "会话根 DOM 标记 data-conversation-session（定位当前会话）",
    pattern: /data-conversation-session/u,
    breaks: "输入框 ↑/↓ 召回与 Esc Esc 无法判断是哪个会话",
  },
  {
    file: "@deepseek-ai/dsh-tools/lib/index.js",
    name: "tools.register(definition)（插件注册 agent 工具）",
    pattern: /register\(definition/u,
    breaks: "只读工具 session_rewind_candidates",
  },
  {
    file: "@deepseek-ai/dsh-tools/lib/index.js",
    name: "受支持的 JSON Schema 子集校验（assertSupportedJsonSchema）",
    pattern: /assertSupportedJsonSchema/u,
    breaks: "只读工具的 schema 是否被接受（子集变了会静默不注册）",
  },
  {
    file: "@deepseek-ai/dsh-agent-loop/lib/index.js",
    name: "Agent.cancel(cause, {keepInbox}) + whenIdle()",
    pattern: /keepInbox[\s\S]{0,400}whenIdle|whenIdle[\s\S]{0,400}keepInbox/u,
    breaks: "运行中回合的回溯（会退回「先停止再回溯」）",
  },
  {
    file: "@deepseek-ai/dsh-agent-loop/lib/index.js",
    name: "agent.inbox.nextStep / remove（丢弃未投递插话）",
    pattern: /get nextStep\(\)[\s\S]{0,800}remove\(messageId\)|remove\(messageId\)/u,
    breaks: "回溯时清理排队中的插话消息",
  },
];

/** session-delete 依赖的私有 seam（服务方法级别的能力探测）。 */
const SEAM_CHECKS_SESSION_DELETE = [
  {
    file: "@deepseek-ai/dsh-workspace/lib/index.js",
    name: "workspace.archiveSession（删除即归档）",
    pattern: /archiveSession\s*\(/u,
    breaks: "删除会话时把它从工作区摘掉",
  },
  {
    file: "@deepseek-ai/dsh-workspace/lib/index.js",
    name: "workspace.unarchiveSession（恢复即取消归档）",
    pattern: /unarchiveSession\s*\(/u,
    breaks: "从回收站恢复会话时把它挂回工作区",
  },
  {
    file: "@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js",
    name: "后端 locate()（拿会话真实目录，避免全盘扫描）",
    pattern: /locate\s*\(/u,
    breaks: "删除/恢复时定位会话目录（退化为扫描，仍可用但更慢）",
  },
  {
    file: "@deepseek-ai/dsh-session/lib/index.js",
    name: "sessions.detachEntered（摘掉 live 条目）",
    pattern: /detachEntered/u,
    breaks: "删除正在被宿主持有的会话（不摘会残留 live 句柄）",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-workspace/lib/client.js",
    name: "sidebar.workspaces.session.menu.item 槽（会话「…」菜单项）",
    pattern: /sidebar\.workspaces\.session\.menu\.item/u,
    breaks: "会话右键菜单里的「删除」入口",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-cordis/lib/client.js",
    name: "sidebar.footer.action 槽（回收站入口）",
    pattern: /sidebar\.footer\.action/u,
    breaks: "侧栏页脚的回收站入口与角标",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-settings-general/lib/client.js",
    name: "settings.section 槽（设置页「会话回收站」分节）",
    pattern: /settings\.section/u,
    breaks: "审计 / 体检 / 回执 / 偏好没有落点（设置页少一整节）",
  },
  {
    // 文件名带内容哈希，每个版本都不同：用 filePattern 扫，不写死（rc.2 = index-ghOpC9uV.js，rc.3 = index-Ciz7DZxv.js）。
    filePattern:
      /^\/dsh\/node_modules\/@deepseek-ai\/dsh-web-frontend\/dist\/assets\/index-.*\.js$/u,
    name: "Modal 的 [data-modal-autofocus] 焦点约定（确认按钮默认选中）",
    pattern: /data-modal-autofocus/u,
    breaks: "确认框不再默认聚焦「移入回收站」，回车即删的手感退化",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-context-menu/lib/client.js",
    name: "contextMenus 服务（会话「…」/ 工作区「…」菜单贡献）",
    pattern: /contextMenus/u,
    breaks: "菜单退回旧 slot：没有键位显示，工作区菜单里也不会出现批量入口",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-workspace/lib/client.js",
    name: "contextMenus 的 workspace 目标（工作区「…」菜单）",
    pattern: /workspaceMenuTarget/u,
    breaks: "工作区「…」里没有「删除此工作区的全部会话」",
  },
  {
    file: "@deepseek-ai/dsh-client-shortcuts/lib/client.js",
    name: "shortcuts.register（可改键的应用命令）",
    pattern: /registerFixed/u,
    breaks: "⌘⌥⌫ 与 设置 → 通用 → 快捷键 里的条目都消失（菜单仍可用）",
  },
];

/** next-step 依赖的私有 seam（决策卡 + 幽灵提示）。 */
const SEAM_CHECKS_NEXT_STEP = [
  {
    file: "@deepseek-ai/dsh-client-ui-chat/lib/client.js",
    name: "conversation.chat.turnTail 槽（答后卡片的渲染位置）",
    pattern: /conversation\.chat\.turnTail[\s\S]{0,400}openFile/u,
    breaks: "决策卡没有渲染位置（卡片仍会落库，但界面永远空白）",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
    name: "conversation.input.overlay 槽（幽灵提示载体）",
    pattern: /conversation\.input\.overlay/u,
    breaks: "输入框幽灵提示无处渲染（该面默认关闭）",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
    name: "composer placeholder DOM（幽灵提示对齐用）",
    pattern: /data-composer-placeholder/u,
    breaks: "幽灵提示无法与真实输入同基线（会错位或落回左上角）",
  },
  {
    file: "@deepseek-ai/dsh-session-projection/lib/index.js",
    name: "sessionProjections.register(definition)（卡片状态投影）",
    pattern: /super\(ctx, "sessionProjections"\)[\s\S]{0,4000}register\(definition\)/u,
    breaks: "客户端读不到卡片状态（卡片仍落库，界面不显示）",
  },
  {
    file: "@deepseek-ai/dsh-session/lib/index.js",
    name: "appendPluginRecord / pluginRecordOf（卡片与决策的落库通道）",
    pattern: /function appendPluginRecord\([\s\S]{0,600}function pluginRecordOf\(/u,
    breaks: "卡片与决策无法写入/重建，刷新后状态全丢",
  },
  {
    file: "@deepseek-ai/dsh-agent-loop/lib/index.js",
    name: "turn/end 事件与 reason.kind（生成时机门控）",
    pattern: /append\("turn\/end",\s*\{[\s\S]{0,120}reason/u,
    breaks: "插件不知道一轮何时正常结束（会退化为不生成或乱生成）",
  },
  {
    file: "@deepseek-ai/dsh-llm/lib/index.js",
    name: "llm.prepareCall + call.stream（一次额外补全）",
    pattern: /async prepareCall\(config, signal[\s\S]{0,4000}stream: \(options\)/u,
    breaks: "无法发起额外模型调用 → 决策卡与幽灵提示整体失效",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-conversation/lib/client.js",
    name: '输入框 submit(mode = "queue")（点击即发送的通道）',
    pattern: /submit\(\s*mode\s*=\s*[`"']queue[`"']/u,
    breaks: "点击胶囊无法把文本作为用户消息发出",
  },
];

const SEAM_CHECKS_ADVISOR = [
  {
    file: "@deepseek-ai/dsh-llm/lib/index.js",
    name: "llm.resolveModelInfo(provider, model)（思考档/上下文元数据）",
    pattern: /resolveModelInfo\s*\(/u,
    breaks: "选模型时拿不到该模型真实支持的思考档（下拉会退化成只有「自动」）",
  },
  {
    file: "@deepseek-ai/dsh-llm/lib/index.js",
    name: "prepareCall(config, signal, configure)（按模型元数据选思考档）",
    pattern: /async prepareCall\(config, signal[\s\S]{0,600}?configure/u,
    breaks: "无法在发起前按模型能力选定思考档（只能盲传，失败后降级重试）",
  },
  {
    file: "@deepseek-ai/dsh-llm/lib/index.js",
    name: "UNSUPPORTED_REASONING_EFFORT 错误码（降级重试的判据）",
    pattern: /UNSUPPORTED_REASONING_EFFORT/u,
    breaks: "思考档不被支持时无法识别，会直接把失败抛给用户",
  },
  {
    file: "@deepseek-ai/dsh-llm/lib/index.js",
    name: "StreamChunk 的 usage 分片（自己记账的唯一来源）",
    pattern: /case\s*"usage":/u,
    breaks: "额外模型调用的 token 完全无法计量（宿主不写 usage 事件）",
  },
  {
    file: "@deepseek-ai/dsh-commands/lib/index.js",
    name: "commands.register(definition)（/advisor 命令面）",
    pattern: /register\(definition\)\s*\{/u,
    breaks: "/advisor 命令不存在，只能靠工具与设置文件配置顾问",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-commands/lib/client.js",
    name: "commandUi.decorate(decoration)（给 /advisor 挂选择器）",
    pattern: /decorate\(decoration\)/u,
    breaks: "/advisor 无法挂自定义 UI（只能输出纯文本）",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-commands/lib/client.js",
    name: "popupSelect 选择器类型（模型选择器）",
    pattern: /popupSelect/u,
    breaks: "/advisor 弹不出模型选择器（退化为让用户手打 provider/model）",
  },
];

/**
 * 宿主服务：**注册点**（`provide("<名字>"` 或服务类构造）还在不在。
 *
 * AUD-XCT-01（2026-11-28）：旧清单只覆盖 session-rewind / session-delete / next-step /
 * advisor 四个插件，btw / artifacts / casefile / projects 的宿主面一条都没有——升级时
 * 谁把 `subagents`、`webServer`、`sessionController` 改掉，探针仍然全绿。这里按四个插件的
 * 实际 `ctx.inject([...])` / `ctx.get(...)` 用法补上，`breaks` 写清「没了哪个功能会坏」。
 */
const HOST_SERVICE_CHECKS = [
  {
    file: "@deepseek-ai/dsh-agent/lib/index.js",
    service: "agents",
    breaks: "btw 旁问 fork 子代理、projects 线程/协调者起子代理",
  },
  {
    file: "@deepseek-ai/dsh-subagent/lib/index.js",
    service: "subagents",
    breaks: "btw 旁问的 fork 子代理（承载 /btw 的核心执行面）",
  },
  {
    file: "@deepseek-ai/dsh-token-meter/lib/index.js",
    service: "tokenMeter",
    breaks: "btw 旁问的 token / 缓存命中计量（成本提示与账本）",
  },
  {
    file: "@deepseek-ai/dsh-commands/lib/index.js",
    service: "commands",
    breaks: "btw `/btw`、advisor `/advisor`、session-rewind `/rewind` 斜杠命令注册",
  },
  {
    file: "@deepseek-ai/dsh-session/lib/index.js",
    service: "sessions",
    breaks: "btw 读当前会话上下文、session-delete 判断会话是否 live",
  },
  {
    file: "@deepseek-ai/dsh-workspace/lib/index.js",
    service: "workspaceRegistry",
    breaks: "btw 的会话归属、projects 工作区/线程绑定与归档、session-delete 归档",
  },
  {
    file: "@deepseek-ai/dsh-api-session-controller/lib/index.js",
    service: "sessionController",
    breaks: "casefile 读会话/工具上下文、projects 线程与会话控制",
  },
  {
    file: "@deepseek-ai/dsh-host-webserver/lib/index.js",
    service: "webServer",
    breaks: "artifacts 的 `/artifacts/<id>` 预览路由（面板与下载全部 404）",
  },
  {
    file: "@deepseek-ai/dsh-api-workspace-files/lib/index.js",
    service: "workspaceFiles",
    breaks: "projects Library 在 artifacts 缺失时退回工作区文件列表",
  },
  {
    file: "@deepseek-ai/dsh-user-approval/lib/index.js",
    service: "approval",
    breaks: "projects 危险动作（push / PR / merge）的人工审批闸",
  },
  {
    file: "@deepseek-ai/dsh-permission-presets/lib/index.js",
    service: "permissionPresets",
    breaks: "projects 的权限档位选择与自动收窄",
  },
  {
    file: "@deepseek-ai/dsh-sandbox-policy/lib/index.js",
    service: "sandboxPolicy",
    breaks: "projects 的沙箱策略（线程执行的边界）",
  },
  {
    file: "@deepseek-ai/dsh-schedule/lib/index.js",
    service: "schedule",
    breaks: "projects 的提醒 / 定时任务",
  },
  {
    file: "@deepseek-ai/dsh-system-prompt/lib/index.js",
    service: "systemPrompt",
    breaks: "projects 把项目常设规则与 MEMORY.md 注入每次请求",
  },
  {
    file: "@deepseek-ai/dsh-storage-domain/lib/index.js",
    service: "storageDomain",
    breaks: "btw / projects 的偏好跨重启持久化（firstRunDone、折叠状态等）",
  },
  {
    file: "@deepseek-ai/dsh-subprocess/lib/index.js",
    service: "subprocess",
    breaks: "projects 的 `git` / `gh` 子进程（worktree、push、PR 全走它）",
  },
];

/**
 * client 半的宿主服务（浏览器侧服务，由官方 client 包 `provide` / 服务类注册）。
 * 与 HOST_SERVICE_CHECKS 一样：检查注册点是否还在。
 */
const CLIENT_SERVICE_CHECKS = [
  {
    file: "@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js",
    service: "sidebarRight",
    pattern: /provide\(\s*[`"']sidebarRight[`"']/u,
    breaks: "btw / artifacts / projects 打开与关闭右栏页签（openTab / closeIn）",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js",
    service: "sidebarRightTabs",
    pattern: /provide\(\s*[`"']sidebarRightTabs[`"']/u,
    breaks: "btw / artifacts 在右栏注册自己的页签（`ctx.sidebarRightTabs.register`）",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-input-trigger/lib/client.js",
    service: "inputTriggers",
    pattern: /super\(\s*ctx\s*,\s*[`"']inputTriggers[`"']/u,
    breaks: "projects 输入框 `@` 提及源（缺服务时该功能明示不可用）",
  },
  {
    file: "@deepseek-ai/dsh-client-ui-context-menu/lib/client.js",
    service: "contextMenus",
    pattern: /provide\(\s*[`"']contextMenus[`"']/u,
    breaks: "projects / session-delete 的右键菜单贡献（含键位显示）",
  },
  {
    file: "@deepseek-ai/dsh-client-locale/lib/client.js",
    service: "locale",
    pattern: /provide\(\s*[`"']locale[`"']/u,
    breaks: "所有插件的 client 文案绑定（缺了只剩 fallback 英文）",
  },
  {
    file: "@deepseek-ai/dsh-client-connection/lib/client.browser.js",
    service: "connection",
    pattern: /provide\(\s*[`"']connection[`"']/u,
    breaks: "所有插件的 client→host RPC（面板、设置、命令全部打不通）",
  },
];

/**
 * slot 名字通过扫描 client 包确认（客户端 bundle 里以字符串出现）。
 *
 * 清单 = 8 个插件**实际** `slots.inject` / `slots.register` 的槽位（2026-11-28 按代码复核，
 * 见 AUD-XCT-01）。rc.2 起 bundle 用反引号，所以扫描同时认 `"`、`'`、`` ` `` 三种引号；
 * `main` 这种过短的字符串额外要求 `name:` 前缀，避免命中普通字符串。
 * 已删掉两个没有任何插件注入的槽（`conversation.input.dock` / `conversation.composer`）。
 */
const SLOT_CHECKS = [
  {
    slot: "settings.section",
    purpose:
      "设置分节（session-delete / session-rewind / advisor / next-step / projects / btw / casefile）",
  },
  { slot: "shell.overlay", purpose: "确认框 / 面板 / toast（六插件共用）" },
  {
    slot: "sidebar.workspaces.session.menu.item",
    purpose: "会话「…」菜单项（session-delete / projects）",
  },
  { slot: "sidebar.footer.action", purpose: "侧栏页脚回收站入口（session-delete）" },
  { slot: "sidebar.right.pane.tab", purpose: "右栏面板页签（btw / artifacts）" },
  { slot: "sidebar.panellist", purpose: "侧栏面板入口（casefile / projects）" },
  {
    slot: "main",
    purpose: "主面板插槽（casefile / projects 的 keyed 面板）",
    pattern: /name\s*:\s*[`"']main[`"']/u,
  },
  { slot: "tool.call.toolview", purpose: "工具调用视图（artifacts 摘要行）" },
  { slot: "conversation.session.header.actions", purpose: "会话头部（回溯面板入口）" },
  { slot: "conversation.input.overlay", purpose: "输入框幽灵提示（next-step）" },
  { slot: "conversation.input.left", purpose: "输入框左侧按钮（btw 开关）" },
  { slot: "conversation.chat.turnTail", purpose: "答后卡片（advisor / next-step）" },
  { slot: "conversation.chat.node", purpose: "消息行（↶ 按钮注入）" },
  { slot: "contextMenu.icon", purpose: "菜单图标（session-delete 的回收站图标，缺了菜单仍可用）" },
];

/** bundle 里字符串的三种引号（rc.2 起用反引号，更早用双引号）。 */
const QUOTES = ["`", '"', "'"];

/**
 * 服务注册点判断。宿主有两种写法：
 *   - Cordis Service 子类构造：`super(ctx, "<名字>")`（大多数宿主服务）；
 *   - 动态注册：`ctx.provide("<名字>", ...)`（如 storageDomain、client 半的 contextMenus）。
 * 两种都认，字符串字面量三种引号都认。
 * @param {string} text
 * @param {string} service
 * @returns {boolean}
 */
function providesService(text, service) {
  return QUOTES.some(
    (quote) =>
      new RegExp(`super\\(\\s*(?:this\\.)?ctx\\s*,\\s*${quote}${service}${quote}`, "u").test(
        text,
      ) || new RegExp(`provide\\(\\s*${quote}${service}${quote}`, "u").test(text),
  );
}

/**
 * 字符串在源码里以三种引号之一出现的判断。
 * @param {string} text
 * @param {string} value
 * @returns {boolean}
 */
function hasQuotedString(text, value) {
  return (
    text.includes(`"${value}"`) || text.includes(`'${value}'`) || text.includes(`\`${value}\``)
  );
}

/**
 * 读取 asar 的头部索引与按路径读文件的能力。
 * 虚拟路径统一成 `/dsh/node_modules/...`（与桌面版 app.asar 里一致），
 * 这样所有检查项不用关心宿主面是 asar 还是 npm 目录。
 * @param {string} asarPath
 * @returns {Promise<Surface>}
 */
export async function openAsarSurface(asarPath) {
  const handle = await open(asarPath, "r");
  const head = Buffer.alloc(16);
  await handle.read(head, 0, 16, 0);
  const jsonLength = head.readUInt32LE(12);
  const jsonBuffer = Buffer.alloc(jsonLength);
  await handle.read(jsonBuffer, 0, jsonLength, 16);
  const index = JSON.parse(jsonBuffer.toString("utf8"));
  // header JSON 之后会补齐到 4 字节边界，文件数据从补齐后的位置开始。
  // 少算这段填充（0–3 字节）会让每次按 offset 读文件都整体偏移，
  // 表现为 package.json 解析失败、特征匹配落在错误位置（实测 0.2.2-rc.1 偏 2 字节）。
  const dataStart = 16 + Math.ceil(jsonLength / 4) * 4;
  /** @type {Map<string, { offset: number, size: number }>} */
  const files = new Map();
  /** @param {any} node @param {string} prefix */
  const walkIndex = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${name}`;
      if (value && typeof value === "object" && "files" in value) walkIndex(value, path);
      else if (value && typeof value === "object" && "size" in value && "offset" in value) {
        files.set(path, { offset: Number(value.offset), size: Number(value.size) });
      }
    }
  };
  walkIndex(index, "");
  return {
    kind: "asar",
    path: asarPath,
    files,
    /** @param {string} path */
    async read(path) {
      const entry = files.get(path);
      if (!entry) return undefined;
      const buffer = Buffer.alloc(entry.size);
      await handle.read(buffer, 0, entry.size, dataStart + entry.offset);
      return buffer;
    },
    async close() {
      await handle.close();
    },
  };
}

/**
 * 解析 `--surface` 指向的目录：既接受 node_modules 本身，也接受它的父目录
 * （`<prefix>` 里有 `node_modules/@deepseek-ai`）。
 * @param {string} dir
 * @returns {string}
 */
function resolveSurfaceRoot(dir) {
  const direct = join(dir, "@deepseek-ai");
  if (existsSync(direct)) return dir;
  const nested = join(dir, "node_modules");
  if (existsSync(join(nested, "@deepseek-ai"))) return nested;
  return dir;
}

/**
 * 打开 npm 装出来的宿主 surface 目录（虚拟路径同样映射到 `/dsh/node_modules/...`）。
 * 只枚举 `@deepseek-ai/` 下的文件：探针检查的全部对象都在这里，跳过平台二进制可省一大截。
 * @param {string} dir
 * @returns {Promise<Surface>}
 */
export async function openDirectorySurface(dir) {
  const root = resolveSurfaceRoot(dir);
  /** @type {Map<string, { path: string, size: number }>} */
  const files = new Map();
  /**
   * @param {string} absDir
   * @param {string} rel
   */
  const walkDir = async (absDir, rel) => {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(absDir, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walkDir(abs, childRel);
      else if (entry.isFile()) files.set(`/dsh/node_modules/${childRel}`, { path: abs, size: 0 });
    }
  };
  await walkDir(join(root, "@deepseek-ai"), "@deepseek-ai");
  return {
    kind: "npm",
    path: root,
    files,
    /** @param {string} path */
    async read(path) {
      const entry = files.get(path);
      if (!entry) return undefined;
      try {
        return await readFile(entry.path);
      } catch {
        return undefined;
      }
    },
    async close() {},
  };
}

/**
 * 宿主版本：桌面版取 `/dsh/package.json`（desktop-runtime），npm surface 退到
 * `@deepseek-ai/dsh` 的 package.json——两者都该是本轮目标运行时版本。
 * @param {Surface} surface
 * @returns {Promise<string>}
 */
export async function readGuestVersion(surface) {
  for (const path of ["/dsh/package.json", "/dsh/node_modules/@deepseek-ai/dsh/package.json"]) {
    const buffer = await surface.read(path);
    if (!buffer) continue;
    try {
      const version = JSON.parse(buffer.toString("utf8")).version;
      if (typeof version === "string" && version !== "") return version;
    } catch {
      /* 解析失败继续试下一个 */
    }
  }
  return "?";
}

/**
 * 跑一组「私有 seam」检查，按功能影响分组报告。
 *
 * 定位目标文件有两种写法：
 *   - `file`：相对 `/dsh/node_modules/` 的固定路径（`lib/client.js`、`lib/index.js` 这类）。
 *   - `filePattern`：对 asar 全路径做正则，扫到哪个算哪个。**文件名带内容哈希的产物必须用它**
 *     ——例如 web-frontend 的 `dist/assets/index-<hash>.js`，每个版本的哈希都不同。写死会让探针
 *     在每次升级都误报 FAIL（规则 1：不写死 DSH 内部实现，扫描 + 匹配已知模式）。
 *
 * @param {Surface} surface
 * @param {(kind: "PASS"|"FAIL"|"WARN", name: string, detail: string) => void} push
 * @param {{ file?: string, filePattern?: RegExp, name: string, pattern: RegExp, breaks: string }[]} checks
 */
async function runSeamChecks(surface, push, checks) {
  for (const check of checks) {
    const paths = check.filePattern
      ? [...surface.files.keys()].filter((path) => check.filePattern?.test(path))
      : [`/dsh/node_modules/${check.file}`];
    if (paths.length === 0) {
      const label = check.file ?? String(check.filePattern);
      push("FAIL", `seam ${check.name}`, `文件不存在：${label}｜影响：${check.breaks}`);
      continue;
    }
    let matched = false;
    for (const path of paths) {
      const buffer = await surface.read(path);
      if (buffer && check.pattern.test(buffer.toString("utf8"))) {
        matched = true;
        break;
      }
    }
    push(
      matched ? "PASS" : "FAIL",
      `seam ${check.name}`,
      matched ? "" : `源码里没有匹配到特征｜影响：${check.breaks}`,
    );
  }
}

/**
 * 跑一条「宿主服务还在提供吗」检查：文件存在 + 有 `provide("<名字>"`（或等价注册）。
 * @param {Surface} surface
 * @param {(kind: "PASS"|"FAIL"|"WARN", name: string, detail: string) => void} push
 * @param {{ file: string, service: string, pattern?: RegExp, breaks: string }} check
 */
async function runServiceCheck(surface, push, check) {
  const path = `/dsh/node_modules/${check.file}`;
  const buffer = await surface.read(path);
  if (!buffer) {
    push("FAIL", `service ${check.service}`, `文件不存在：${check.file}｜影响：${check.breaks}`);
    return;
  }
  const text = buffer.toString("utf8");
  const ok = check.pattern ? check.pattern.test(text) : providesService(text, check.service);
  push(
    ok ? "PASS" : "FAIL",
    `service ${check.service}`,
    ok ? check.file : `源码里没有找到服务注册点（${check.file}）｜影响：${check.breaks}`,
  );
}

/**
 * 跑完整清单，返回结果数组（导出给单测用，不依赖 process/CLI）。
 * @param {Surface} surface
 * @returns {Promise<{ version: string, results: { kind: "PASS"|"FAIL"|"WARN", name: string, detail: string }[] }>}
 */
export async function runProbe(surface) {
  /** @type {{ kind: "PASS" | "FAIL" | "WARN", name: string, detail: string }[]} */
  const results = [];
  const push = (
    /** @type {"PASS"|"FAIL"|"WARN"} */ kind,
    /** @type {string} */ name,
    /** @type {string} */ detail,
  ) => results.push({ kind, name, detail });

  // 1) 宿主版本
  const version = await readGuestVersion(surface);
  push(version === "?" ? "WARN" : "PASS", "读取宿主版本", version);

  // 2) 必需宿主包
  for (const pkg of REQUIRED_PACKAGES) {
    const path = `/dsh/node_modules/@deepseek-ai/${pkg}/package.json`;
    const found = surface.files.has(path);
    push(found ? "PASS" : "FAIL", `宿主包 ${pkg}`, found ? "" : "宿主面里不存在");
  }

  // 3) API 面
  for (const check of API_CHECKS) {
    const path = `/dsh/node_modules/${check.file}`;
    const buffer = await surface.read(path);
    if (!buffer) {
      push(check.optional ? "WARN" : "FAIL", check.name, `文件不存在：${path}`);
      continue;
    }
    const text = buffer.toString("utf8");
    const ok = check.pattern.test(text);
    push(
      ok ? "PASS" : check.optional ? "WARN" : "FAIL",
      check.name,
      ok ? "" : "源码里没有匹配到特征",
    );
  }

  // 3.5) 私有 seam（按功能影响分组报告）
  await runSeamChecks(surface, push, SEAM_CHECKS);
  // 3.6) session-delete 的私有 seam
  await runSeamChecks(surface, push, SEAM_CHECKS_SESSION_DELETE);
  // 3.7) next-step 的私有 seam
  await runSeamChecks(surface, push, SEAM_CHECKS_NEXT_STEP);
  // 3.8) advisor 的私有 seam
  await runSeamChecks(surface, push, SEAM_CHECKS_ADVISOR);
  // 3.9) 宿主服务注册点（btw / artifacts / casefile / projects 的宿主面）
  for (const check of HOST_SERVICE_CHECKS) await runServiceCheck(surface, push, check);
  // 3.10) client 半的宿主服务
  for (const check of CLIENT_SERVICE_CHECKS) await runServiceCheck(surface, push, check);

  // 4) slot：扫描所有 client 包的 lib/*.js（含 client.browser.js 这类文件名）
  const clientFiles = [...surface.files.keys()].filter((path) =>
    /^\/dsh\/node_modules\/@deepseek-ai\/dsh-client-[^/]+\/lib\/[^/]+\.js$/u.test(path),
  );
  for (const check of SLOT_CHECKS) {
    let owner;
    for (const path of clientFiles) {
      const buffer = await surface.read(path);
      if (!buffer) continue;
      const text = buffer.toString("utf8");
      const hit = check.pattern ? check.pattern.test(text) : hasQuotedString(text, check.slot);
      if (hit) {
        owner = path.replace("/dsh/node_modules/@deepseek-ai/", "");
        break;
      }
    }
    push(
      owner ? "PASS" : "FAIL",
      `slot ${check.slot}（${check.purpose}）`,
      owner ?? "客户端 bundle 里找不到",
    );
  }

  return { version, results };
}

const main = async () => {
  const { values } = parseArgs({
    options: {
      asar: { type: "string" },
      surface: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const explicit = values.asar ?? values.surface ?? process.env.DSH_ASAR;
  const asarPath = values.asar ?? process.env.DSH_ASAR ?? DEFAULT_ASAR;
  /** @type {Surface | undefined} */
  let surface;
  if (values.surface !== undefined) {
    const dir = resolve(values.surface);
    if (!existsSync(dir)) {
      console.error(`找不到 --surface 目录：${dir}`);
      console.error(
        "用 `node scripts/prepare-dsh-surface.mjs --output <dir>` 按目标版本从 npm 装一份宿主面。",
      );
      process.exitCode = 2;
      return;
    }
    surface = await openDirectorySurface(dir);
  } else if (existsSync(asarPath)) {
    surface = await openAsarSurface(asarPath);
  } else {
    if (explicit !== undefined) {
      console.error(`找不到 app.asar：${asarPath}`);
      console.error("用 --asar <path>、--surface <node_modules 目录> 或 DSH_ASAR=<path> 指定。");
      process.exitCode = 2;
      return;
    }
    console.log(`SKIP 没找到默认的 DSH 安装（${asarPath}）；这通常意味着不在装了 DSH 的机器上`);
    console.log(
      "     CI 里请先 `node scripts/prepare-dsh-surface.mjs` 并用 --surface 显式指向它。",
    );
    return;
  }

  if (surface === undefined) {
    console.error("FAIL 没有可用的宿主面（既没有 --asar 也没有 --surface）");
    process.exitCode = 2;
    return;
  }
  try {
    const { version, results } = await runProbe(surface);
    if (values.json) {
      console.log(
        JSON.stringify(
          { surface: { kind: surface.kind, path: surface.path }, version, results },
          null,
          2,
        ),
      );
    } else {
      console.log("DSH runtime probe");
      console.log(`surface: ${surface.path}（${surface.kind}）`);
      console.log(`version: ${version}`);
      console.log("");
      for (const item of results) {
        const tag = item.kind === "PASS" ? "PASS" : item.kind === "WARN" ? "WARN" : "FAIL";
        console.log(`${tag}  ${item.name}${item.detail ? ` :: ${item.detail}` : ""}`);
      }
      const failed = results.filter((item) => item.kind === "FAIL").length;
      const warned = results.filter((item) => item.kind === "WARN").length;
      if (failed > 0) {
        console.log("");
        console.log("升级影响（按功能）：");
        for (const item of results) {
          if (item.kind !== "FAIL") continue;
          console.log(`  - ${item.name}`);
        }
        console.log("  上面每一项都对应本仓库插件的一条依赖；FAIL 不等于插件立刻崩，");
        console.log(
          "  多数会走「能力探测 → 降级」，但对应功能会静默消失，请读 README 的兼容性表。",
        );
      }
      console.log("");
      console.log(
        `合计 ${results.length} 项：${results.length - failed - warned} PASS, ${warned} WARN, ${failed} FAIL`,
      );
    }
    process.exitCode = results.some((item) => item.kind === "FAIL") ? 1 : 0;
  } finally {
    await surface.close();
  }
};

if (isMain(import.meta.url)) await main();
