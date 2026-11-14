#!/usr/bin/env node
// @ts-check
// 文档一致性检查：`pnpm check:docs`（CI 与 pnpm verify 都会跑）。
//
// 拦的是「代码改了、文档没跟上」这类漂移——人工 review 很难一直抓到：
//   1. 文档里写的「当前/目标运行时」必须等于 docs/runtime/ 里最新的版本；
//   2. README 徽章里的 verified-on 版本必须等于同一个最新版本；
//   3. 插件 README 的状态行不应写死具体版本号（会漂）；
//   4. ADR 文件必须在 docs/adr/README.md 索引里出现；
//   5. docs/runtime/ 每个版本文件必须被至少一处引用（否则等于写完就没人看）；
//   6. 插件 README 兼容性表格里出现过的版本，必须在 docs/runtime/ 有对应记录；
//   7. 相对链接指向的文件必须存在，`#锚点` 必须能对上目标文件的标题。
//
// 第 7 条是 2026-11-14 补的：改标题（哪怕只是把「两条」改成「三条」）会让指向它的
// `#...` 链接**静默失效**——点进去找不到章节，而前六条都发现不了。
// 已知限制：只校验 Markdown 的 `[x](y)` 形式，不校验 HTML 的 `href`/`src`。
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isMain } from "./lib/repo.mjs";

const REPO = resolve(import.meta.dirname, "..");
/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const warnings = [];

/** @param {string} rel */
const read = (rel) => readFile(join(REPO, rel), "utf8").catch(() => "");

/** @param {string} version */
const versionKey = (version) => {
  const [core, rc] = version.split("-rc.");
  const parts = core.split(".").map((part) => Number(part));
  return [...parts, Number(rc)];
};

/** @param {number[]} left @param {number[]} right */
const compare = (left, right) => {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/** 递归收集仓库内的 Markdown；跳过依赖、.git 与私有的 notes/。 @param {string} dir @returns {Promise<string[]>} */
async function collectMarkdown(dir) {
  /** @type {string[]} */
  const out = [];
  const entries = await readdir(join(REPO, dir), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "notes")
        continue;
      out.push(...(await collectMarkdown(rel)));
    } else if (entry.name.endsWith(".md")) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * GitHub 的标题锚点规则：转小写 → 去掉 HTML 与「非字母/数字/空格/下划线/连字符」→
 * 每个空格换一个连字符。**不折叠**连续连字符，所以 `Cost & privacy` 是 `cost--privacy`、
 * `工作流：Issue → 分支 → PR` 是 `工作流issue--分支--pr`。中日韩字符原样保留。
 * @param {string} heading
 */
export function headingSlug(heading) {
  return heading
    .toLowerCase()
    .replace(/<[^>]*>/gu, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/gu, "-");
}

/**
 * 一段 Markdown 里全部可用锚点（重名标题按 GitHub 规则加 -1/-2 后缀）。
 * @param {string} text
 */
export function anchorSetOf(text) {
  /** @type {Set<string>} */
  const set = new Set();
  // 围栏代码块里的 # 不是标题。
  const body = text.replace(/^```[\s\S]*?^```/gmu, "");
  for (const match of body.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)) {
    // 行内代码渲染后就是纯文本，反引号本身不进锚点。
    const base = headingSlug(match[1].replace(/`([^`]*)`/gu, "$1"));
    let slug = base;
    let n = 1;
    while (set.has(slug)) slug = `${base}-${n++}`;
    set.add(slug);
  }
  return set;
}

/** 文档里的相对链接目标（忽略围栏代码块与行内代码里的 `[]()`）。 @param {string} text */
function linksIn(text) {
  const body = text.replace(/^```[\s\S]*?^```/gmu, "").replace(/`[^`\n]*`/gu, "");
  /** @type {string[]} */
  const out = [];
  for (const match of body.matchAll(/\]\(\s*([^)\s]+)\s*\)/gu)) out.push(match[1]);
  return out;
}

/** @param {string} value */
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 校验一组 Markdown 的相对链接与锚点（纯函数，便于单测）。
 * @param {Map<string, string>} docs 相对仓库根的路径 → 文件内容
 * @param {(rel: string) => boolean} fileExists 目标文件是否存在
 * @returns {{ linkCount: number, errors: string[] }}
 */
export function linkErrors(docs, fileExists) {
  /** @type {Map<string, Set<string>>} */
  const anchorsByFile = new Map();
  for (const [rel, text] of docs) anchorsByFile.set(rel, anchorSetOf(text));
  /** @type {string[]} */
  const errors = [];
  let linkCount = 0;
  for (const [rel, text] of docs) {
    for (const target of linksIn(text)) {
      // 外部链接（含协议相对 //host）不归本检查管。
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) continue;
      linkCount += 1;
      const [pathPart, anchor] = target.split("#");
      if (pathPart === "") {
        if (
          anchor !== undefined &&
          anchor !== "" &&
          !anchorsByFile.get(rel)?.has(safeDecode(anchor))
        ) {
          errors.push(`${rel}：锚点 #${anchor} 在本文件里不存在`);
        }
        continue;
      }
      const targetRel = relative(REPO, resolve(dirname(join(REPO, rel)), safeDecode(pathPart)));
      if (!fileExists(targetRel)) {
        errors.push(`${rel}：链接指向的文件不存在 → ${targetRel}`);
        continue;
      }
      if (anchor !== undefined && anchor !== "" && targetRel.endsWith(".md")) {
        if (!anchorsByFile.get(targetRel)?.has(safeDecode(anchor))) {
          errors.push(`${rel}：链接锚点不存在 → ${targetRel}#${anchor}`);
        }
      }
    }
  }
  return { linkCount, errors };
}

const main = async () => {
  // ---- 1/2/3: 运行时引用与状态行 ----
  const runtimeFiles = (await readdir(join(REPO, "docs/runtime")).catch(() => [])).filter((name) =>
    /^\d+\.\d+\.\d+-rc\.\d+\.md$/u.test(name),
  );
  /** @type {string[]} */
  const versions = runtimeFiles.map((name) => name.replace(/\.md$/u, ""));
  if (versions.length === 0) {
    errors.push("docs/runtime/ 里没有任何版本记录");
  }
  const latest = versions.sort((a, b) => compare(versionKey(b), versionKey(a)))[0] ?? "";

  /** @type {Array<{ path: string, pattern: RegExp, expect: (m: RegExpMatchArray) => string, label: string }>} */
  const runtimeRefs = [
    {
      path: "AGENTS.md",
      pattern: /目标运行时：\*\*DSH 桌面版 (\d+\.\d+\.\d+-rc\.\d+)\*\*/gu,
      expect: (m) => m[1],
      label: "AGENTS.md「目标运行时」",
    },
    {
      path: "docs/plugin-conventions.md",
      pattern: /当前目标运行时：\[DSH (\d+\.\d+\.\d+-rc\.\d+)\]/gu,
      expect: (m) => m[1],
      label: "plugin-conventions「当前目标运行时」",
    },
    {
      path: "README.md",
      pattern: /verified%20on%20DSH-(\d+\.\d+\.\d+)--rc\.(\d+)/gu,
      expect: (m) => `${m[1]}-rc.${m[2]}`,
      label: "README 徽章",
    },
    {
      path: "README.zh-CN.md",
      pattern: /verified%20on%20DSH-(\d+\.\d+\.\d+)--rc\.(\d+)/gu,
      expect: (m) => `${m[1]}-rc.${m[2]}`,
      label: "README.zh-CN 徽章",
    },
  ];
  for (const ref of runtimeRefs) {
    const text = await read(ref.path);
    const matches = [...text.matchAll(ref.pattern)];
    if (matches.length === 0) {
      warnings.push(`${ref.label}：没找到版本标记（措辞变了？）`);
      continue;
    }
    for (const match of matches) {
      const found = ref.expect(match);
      if (latest !== "" && found !== latest) {
        errors.push(`${ref.label} 写的是 ${found}，但 docs/runtime 最新是 ${latest}`);
      }
    }
  }

  // 插件 README 状态行不应写死版本号
  const pluginDirs = (await readdir(join(REPO, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const plugin of pluginDirs) {
    for (const file of ["README.md", "README.zh-CN.md"]) {
      const text = await read(`packages/${plugin}/${file}`);
      if (/^\s*>\s*\*\*(Status|状态)[:：][^*]*v\d+\.\d+\.\d+/mu.test(text)) {
        errors.push(`packages/${plugin}/${file}：状态行写死了版本号（会漂），改用不依赖版本的措辞`);
      }
    }
  }

  // ---- 4: ADR 必须被索引 ----
  const adrIndex = await read("docs/adr/README.md");
  for (const name of await readdir(join(REPO, "docs/adr")).catch(() => [])) {
    if (!/^\d{4}-.+\.md$/u.test(name) || name.startsWith("0000")) continue;
    if (!adrIndex.includes(name))
      errors.push(`docs/adr/${name} 没有出现在 docs/adr/README.md 索引里`);
  }

  // ---- 5: 每个 runtime 文档都要被引用 ----
  /** @type {Map<string, string>} */
  const mdFiles = new Map();
  const collect = async (/** @type {string} */ rel) => {
    const text = await read(rel);
    if (text !== "") mdFiles.set(rel, text);
  };
  for (const name of await readdir(join(REPO, "docs/runtime")).catch(() => [])) {
    await collect(`docs/runtime/${name}`);
  }
  for (const name of await readdir(join(REPO, "docs/adr")).catch(() => [])) {
    await collect(`docs/adr/${name}`);
  }
  for (const name of await readdir(join(REPO, "docs/testing")).catch(() => [])) {
    await collect(`docs/testing/${name}`);
  }
  await collect("AGENTS.md");
  await collect("README.md");
  await collect("README.zh-CN.md");
  for (const version of versions) {
    const cited = [...mdFiles.entries()].some(
      ([path, text]) => !path.endsWith(`${version}.md`) && text.includes(`${version}.md`),
    );
    if (!cited) warnings.push(`docs/runtime/${version}.md 没有被任何文档引用`);
  }

  // ---- 7: 相对链接与锚点（按 GitHub 的渲染规则） ----
  const docFiles = await collectMarkdown(".");
  /** @type {Map<string, string>} */
  const docs = new Map();
  for (const rel of docFiles) docs.set(rel, await read(rel));
  const links = linkErrors(docs, (rel) => existsSync(join(REPO, rel)));
  errors.push(...links.errors);

  for (const item of errors) console.error(`FAIL ${item}`);
  for (const item of warnings) console.warn(`WARN ${item}`);
  if (errors.length > 0) {
    console.error(`\n文档一致性检查：${errors.length} 个错误，${warnings.length} 个警告`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `文档一致性检查：0 个错误，${warnings.length} 个警告（含 ${docFiles.length} 个 Markdown、${links.linkCount} 条本地链接/锚点）`,
  );
};

if (isMain(import.meta.url)) await main();
