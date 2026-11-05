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
];

/** slot 名字通过扫描 client 包确认（客户端 bundle 里以字符串出现）。 */
const SLOT_CHECKS = [
  { slot: "sidebar.workspaces.session.menu.item", purpose: "会话「…」菜单" },
  { slot: "sidebar.footer.action", purpose: "侧栏页脚回收站入口" },
  { slot: "shell.overlay", purpose: "确认框 / 面板 / toast" },
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
  const dataStart = 16 + jsonLength;
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
