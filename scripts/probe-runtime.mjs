#!/usr/bin/env node
import { existsSync } from "node:fs";
// @ts-check
// 用法：pnpm probe:runtime [--asar <path>] [--json]
//
// DSH 升级前/后的体检：直接解析 app.asar 的目录索引，核对本仓库插件依赖的
// 宿主包、API 与 slot 是否还在。不启动宿主、不改任何文件。
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";

const DEFAULT_ASAR = "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";

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
    pattern: /super\(ctx, "slots"\)/u,
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
    pattern: /conversation\.chat\.node[\s\S]{0,200}key:\s*"user"/u,
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
    name: "shortcuts.observeFixedInput（判断是否空闲）",
    pattern: /observeFixedInput/u,
    breaks: "Esc Esc 只在空闲会话生效（可能抢内置停止）",
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

/** slot 名字通过扫描 client 包确认（客户端 bundle 里以字符串出现）。 */
const SLOT_CHECKS = [
  { slot: "sidebar.workspaces.session.menu.item", purpose: "会话「…」菜单" },
  { slot: "sidebar.footer.action", purpose: "侧栏页脚回收站入口" },
  { slot: "shell.overlay", purpose: "确认框 / 面板 / toast" },
  { slot: "conversation.chat.node", purpose: "消息行（↶ 按钮注入）" },
  { slot: "conversation.session.header.actions", purpose: "会话头部（回溯面板入口）" },
  { slot: "conversation.input.dock", purpose: "输入框 dock（命令面板）" },
  { slot: "conversation.composer", purpose: "composer 插槽" },
];

/**
 * 读取 asar 的头部索引与按路径读文件的能力。
 * @param {string} asarPath
 */
async function openAsar(asarPath) {
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
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${name}`;
      if (value && typeof value === "object" && "files" in value) walk(value, path);
      else if (value && typeof value === "object" && "size" in value && "offset" in value) {
        files.set(path, { offset: Number(value.offset), size: Number(value.size) });
      }
    }
  };
  walk(index, "");
  return {
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

const main = async () => {
  const { values } = parseArgs({
    options: {
      asar: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const asarPath = values.asar ?? process.env.DSH_ASAR ?? DEFAULT_ASAR;
  if (!existsSync(asarPath)) {
    const explicit = Boolean(values.asar ?? process.env.DSH_ASAR);
    if (explicit) {
      console.error(`找不到 app.asar：${asarPath}`);
      console.error("用 --asar <path> 或 DSH_ASAR=<path> 指定。");
      process.exitCode = 2;
      return;
    }
    console.log(`SKIP 没找到默认的 DSH 安装（${asarPath}）；这通常意味着不在装了 DSH 的机器上`);
    return;
  }

  const asar = await openAsar(asarPath);
  /** @type {{ kind: "PASS" | "FAIL" | "WARN", name: string, detail: string }[]} */
  const results = [];
  const push = (
    /** @type {"PASS"|"FAIL"|"WARN"} */ kind,
    /** @type {string} */ name,
    /** @type {string} */ detail,
  ) => results.push({ kind, name, detail });

  // 1) 宿主版本
  const dshPkg = await asar.read("/dsh/package.json");
  let version = "?";
  if (dshPkg) {
    try {
      version = JSON.parse(dshPkg.toString("utf8")).version ?? "?";
    } catch {
      version = "?";
    }
  }
  push(version === "?" ? "WARN" : "PASS", "读取宿主版本", version);

  // 2) 必需宿主包
  for (const pkg of REQUIRED_PACKAGES) {
    const path = `/dsh/node_modules/@deepseek-ai/${pkg}/package.json`;
    const found = asar.files.has(path);
    push(found ? "PASS" : "FAIL", `宿主包 ${pkg}`, found ? "" : "app.asar 里不存在");
  }

  // 3) API 面
  for (const check of API_CHECKS) {
    const path = `/dsh/node_modules/${check.file}`;
    const buffer = await asar.read(path);
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
  for (const check of SEAM_CHECKS) {
    const path = `/dsh/node_modules/${check.file}`;
    const buffer = await asar.read(path);
    if (!buffer) {
      push("FAIL", `seam ${check.name}`, `文件不存在：${check.file}｜影响：${check.breaks}`);
      continue;
    }
    const ok = check.pattern.test(buffer.toString("utf8"));
    push(
      ok ? "PASS" : "FAIL",
      `seam ${check.name}`,
      ok ? "" : `源码里没有匹配到特征｜影响：${check.breaks}`,
    );
  }

  // 4) slot：扫描所有 client 包的 lib/*.js
  const clientFiles = [...asar.files.keys()].filter((path) =>
    /^\/dsh\/node_modules\/@deepseek-ai\/dsh-client-[^/]+\/lib\/[^/]+\.js$/u.test(path),
  );
  /** @type {Map<string, string>} */
  const slotOwner = new Map();
  for (const path of clientFiles) {
    const known = SLOT_CHECKS.filter((check) => !slotOwner.has(check.slot));
    if (known.length === 0) break;
    const buffer = await asar.read(path);
    if (!buffer) continue;
    const text = buffer.toString("utf8");
    for (const check of known) {
      if (text.includes(`"${check.slot}"`) || text.includes(`'${check.slot}'`)) {
        slotOwner.set(check.slot, path.replace("/dsh/node_modules/@deepseek-ai/", ""));
      }
    }
  }
  for (const check of SLOT_CHECKS) {
    const owner = slotOwner.get(check.slot);
    push(
      owner ? "PASS" : "FAIL",
      `slot ${check.slot}（${check.purpose}）`,
      owner ?? "客户端 bundle 里找不到",
    );
  }

  await asar.close();

  if (values.json) {
    console.log(JSON.stringify({ asar: asarPath, version, results }, null, 2));
  } else {
    console.log("DSH runtime probe");
    console.log(`asar:    ${asarPath}`);
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
      console.log("  多数会走「能力探测 → 降级」，但对应功能会静默消失，请读 README 的兼容性表。");
    }
    console.log("");
    console.log(
      "合计 " +
        results.length +
        " 项：" +
        (results.length - failed - warned) +
        " PASS, " +
        warned +
        " WARN, " +
        failed +
        " FAIL",
    );
  }
  process.exitCode = results.some((item) => item.kind === "FAIL") ? 1 : 0;
};

await main();
