// @ts-check
// check:docs 第 7 条（相对链接与锚点）的单测。
//
// 为什么值得单独锁：锚点是**静默失效**的——改标题不会让任何构建报错，只会让
// `#...` 链接点进去找不到章节。而 GitHub 的 slug 规则有几处反直觉：
//   · 连续空格/被删字符会留下**双连字符**（`Cost & privacy` → `cost--privacy`）；
//   · 中文、点号、全角括号都被整段删除，容易拼错；
//   · 重名标题要加 `-1` / `-2` 后缀。
import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorSetOf, headingSlug, linkErrors } from "../check-docs.mjs";

test("headingSlug：GitHub 的删除与「不折叠连字符」规则", () => {
  assert.equal(headingSlug("Compatibility"), "compatibility");
  // `&` 被删，两侧空格各换一个连字符 → 双连字符（不是折叠成一个）
  assert.equal(headingSlug("Cost & privacy"), "cost--privacy");
  assert.equal(headingSlug("Side effects, limitations & risks"), "side-effects-limitations--risks");
  // 破折号/箭头同样被删
  assert.equal(headingSlug("工作流：Issue → 分支 → PR"), "工作流issue--分支--pr");
  // 点号与全角括号被删，行内代码的反引号不进锚点
  assert.equal(
    headingSlug("2. web 端到端冒烟（`pnpm smoke:advisor`）"),
    "2-web-端到端冒烟pnpm-smokeadvisor",
  );
  assert.equal(headingSlug("compatibility--degradation"), "compatibility--degradation");
});

test("anchorSetOf：围栏代码块里的 # 不算标题，重名加后缀", () => {
  const text = [
    "# Title",
    "```bash",
    "# 这是注释，不是标题",
    "```",
    "## Cost & privacy",
    "## Cost & privacy",
    "## 重复",
  ].join("\n");
  const anchors = anchorSetOf(text);
  assert.ok(anchors.has("title"));
  assert.ok(anchors.has("cost--privacy"));
  assert.ok(anchors.has("cost--privacy-1"), "第二个同名标题应有 -1 后缀");
  assert.ok(anchors.has("重复"));
  assert.ok(!anchors.has("这是注释，不是标题"), "代码块里的 # 不应被当成标题");
});

test("linkErrors：坏锚点、坏文件、坏跨文件锚点都能抓到", () => {
  const docs = new Map([
    [
      "README.md",
      "## Good\n[a](#good)\n[b](#missing)\n[c](docs/x.md)\n[d](nope.md)\n[e](docs/x.md#right)\n[f](docs/x.md#wrong)\n[外链](https://example.com/#whatever)",
    ],
    ["docs/x.md", "## Good\n## Right"],
  ]);
  const existing = new Set(["README.md", "docs/x.md"]);
  const { linkCount, errors } = linkErrors(docs, (rel) => existing.has(rel));
  // 外链不计入本地链接数
  assert.equal(linkCount, 6);
  assert.deepEqual(errors, [
    "README.md：锚点 #missing 在本文件里不存在",
    "README.md：链接指向的文件不存在 → nope.md",
    "README.md：链接锚点不存在 → docs/x.md#wrong",
  ]);
});

test("linkErrors：行内代码与围栏代码块里的 `[]()` 不当链接", () => {
  const docs = new Map([
    ["README.md", "写法是 `[x](#nowhere)`；\n```md\n[y](missing.md)\n```\n[真的](#real)"],
    ["README.md#real", ""],
  ]);
  const { linkCount, errors } = linkErrors(
    docs,
    (rel) => rel === "README.md" || rel === "README.md#real",
  );
  assert.equal(linkCount, 1, "只应把真正的那条算作链接");
  // #real 在 README.md 里不存在 → 应报错
  assert.deepEqual(errors, ["README.md：锚点 #real 在本文件里不存在"]);
});

test("linkErrors：仓库真实文档零错误（回归哨兵）", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const REPO = resolve(import.meta.dirname, "..", "..");
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = async (dir) => {
    for (const entry of await readdir(join(REPO, dir), { withFileTypes: true })) {
      const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "notes"].includes(entry.name)) continue;
        await walk(rel);
      } else if (entry.name.endsWith(".md")) {
        files.push(rel);
      }
    }
  };
  await walk(".");
  /** @type {Map<string, string>} */
  const docs = new Map();
  for (const rel of files) docs.set(rel, await readFile(join(REPO, rel), "utf8"));
  const { errors } = linkErrors(docs, (rel) => existsSync(join(REPO, rel)));
  assert.deepEqual(errors, [], "仓库里的相对链接/锚点应全部可达");
});
