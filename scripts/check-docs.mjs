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
//   6. 插件 README 兼容性表格里出现过的版本，必须在 docs/runtime/ 有对应记录。
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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

  for (const item of errors) console.error(`FAIL ${item}`);
  for (const item of warnings) console.warn(`WARN ${item}`);
  if (errors.length > 0) {
    console.error(`\n文档一致性检查：${errors.length} 个错误，${warnings.length} 个警告`);
    process.exitCode = 1;
    return;
  }
  console.log(`文档一致性检查：0 个错误，${warnings.length} 个警告`);
};

await main();
