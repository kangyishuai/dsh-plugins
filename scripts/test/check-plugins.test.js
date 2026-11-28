// @ts-check
// check-plugins 里两族新规则的离线单测：
// 1) exports 的 `*` 通配按包内文件 glob 匹配（不能拿通配字符串当字面量路径查 existsSync）；
// 2) 插件身份（locale 根 `meta` / package.json 顶层 `icon`）的机械防护。
// 全部用临时目录 fixture，不读真实 packages/，也不加载宿主。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkRepo } from "../check-plugins.mjs";

/** @type {string[]} */
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const EN = {
  meta: { title: "Demo", description: "Demo plugin." },
  demo: { title: "Demo" },
};
const ZH = {
  meta: { title: "演示", description: "演示插件。" },
  demo: { title: "演示" },
};
const INDEX_META = {
  title: { en: "Test index", zh: "测试索引" },
  description: { en: "Test index.", zh: "测试索引。" },
  categories: { tools: { title: { en: "Tools", zh: "工具" } } },
  plugins: {
    "@kangyishuai/dsh-demo": {
      category: "tools",
      title: { en: "Demo", zh: "演示" },
      descriptionZh: "演示插件。",
    },
  },
};

/**
 * 建一个默认能通过 check 的插件 fixture（目录名 demo、版本 1.0.0、已登记索引源）。
 * @param {{indexMeta?: boolean | Record<string, any>}} [options]
 * @returns {{root: string, dir: string}}
 */
function makeRepo(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-check-identity-"));
  roots.push(root);
  const dir = join(root, "packages", "demo");
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "locale"), { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "@kangyishuai/dsh-demo",
        version: "1.0.0",
        description: "Demo plugin.",
        icon: "icon.svg",
        license: "MIT",
        author: "test",
        repository: {
          type: "git",
          url: "git+https://github.com/kangyishuai/dsh-plugins.git",
          directory: "packages/demo",
        },
        type: "module",
        main: "lib/index.js",
        exports: {
          ".": "./lib/index.js",
          "./locale/*.json": "./locale/*.json",
          "./package.json": "./package.json",
        },
        files: ["lib", "locale", "icon.svg", "README.md", "cordis.patch.yml"],
        publishConfig: { access: "public" },
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "lib/index.js"), "export {};\n");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "LICENSE"), "MIT\n");
  writeFileSync(
    join(dir, "cordis.patch.yml"),
    "- insert:\n    - id: demo\n      name: '@kangyishuai/dsh-demo'\n",
  );
  writeFileSync(join(dir, "locale/en.json"), JSON.stringify(EN, null, 2));
  writeFileSync(join(dir, "locale/zh.json"), JSON.stringify(ZH, null, 2));
  writeFileSync(
    join(dir, "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36"></svg>\n',
  );

  if (options.indexMeta !== false) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts/index-meta.json"),
      JSON.stringify(options.indexMeta ?? INDEX_META, null, 2),
    );
  }
  return { root, dir };
}

/** @param {string} dir @returns {Record<string, any>} */
function readPkg(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/** @param {string} dir @param {Record<string, any>} pkg */
function writePkg(dir, pkg) {
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

/**
 * 插件 demo 的 error 文案（checkRepo 里其它插件/仓库级规则不掺进来）。
 * @param {string} root
 * @returns {string}
 */
function errorsOf(root) {
  return checkRepo(root)
    .filter((issue) => issue.level === "error" && issue.plugin === "demo")
    .map((issue) => issue.message)
    .join("\n");
}

/**
 * 插件 demo 的 warning 文案（用于验证 0.0.0 脚手架「只告警」的口径）。
 * @param {string} root
 * @returns {string}
 */
function warningsOf(root) {
  return checkRepo(root)
    .filter((issue) => issue.level === "warn" && issue.plugin === "demo")
    .map((issue) => issue.message)
    .join("\n");
}

test("默认 fixture（通配 locale exports + meta + 合法 icon）零错误", () => {
  const { root } = makeRepo();
  assert.equal(errorsOf(root), "");
});

test("通配 exports 按包内文件 glob 匹配，且接受未逐个列出的语言文件", () => {
  const { root, dir } = makeRepo();
  // 新增一种语言的 locale 文件：通配 `./locale/*.json` 应该自动覆盖它。
  writeFileSync(join(dir, "locale/ja.json"), JSON.stringify({ meta: { title: "デモ" } }, null, 2));
  assert.equal(errorsOf(root), "");
});

test("字面量 exports 指向缺文件仍报错", () => {
  const { root, dir } = makeRepo();
  const pkg = readPkg(dir);
  pkg.exports["./lib/missing.js"] = "./lib/missing.js";
  writePkg(dir, pkg);
  assert.match(
    errorsOf(root),
    /exports\["\.\/lib\/missing\.js"\] 指向的 \.\/lib\/missing\.js 不存在/,
  );
});

test("逐文件显式 locale exports 漏掉一个语言文件时报错（宿主会丢整套 meta/icon）", () => {
  const { root, dir } = makeRepo();
  const pkg = readPkg(dir);
  pkg.exports = {
    ".": "./lib/index.js",
    "./locale/en.json": "./locale/en.json",
    "./locale/zh.json": "./locale/zh.json",
    "./package.json": "./package.json",
  };
  writePkg(dir, pkg);
  writeFileSync(join(dir, "locale/ja.json"), JSON.stringify({ meta: { title: "デモ" } }, null, 2));
  assert.match(errorsOf(root), /locale\/ja\.json 未被 exports 覆盖/);
});

test("locale 根 meta.title / meta.description 必须存在且非空", () => {
  const zh = { demo: { title: "演示" } };
  const { root, dir } = makeRepo();
  writeFileSync(join(dir, "locale/zh.json"), JSON.stringify(zh, null, 2));
  const messages = errorsOf(root);
  assert.match(messages, /locale\/zh\.json 缺少非空的 meta\.title/);
  assert.match(messages, /locale\/zh\.json 缺少非空的 meta\.description/);

  const { root: root2, dir: dir2 } = makeRepo();
  const empty = { ...ZH, meta: { title: "演示", description: "   " } };
  writeFileSync(join(dir2, "locale/zh.json"), JSON.stringify(empty, null, 2));
  assert.match(errorsOf(root2), /locale\/zh\.json 缺少非空的 meta\.description/);
});

test("locale/zh.json 的 meta 必须与 scripts/index-meta.json 的中文身份一致", () => {
  const { root, dir } = makeRepo();
  const zh = { ...ZH, meta: { title: "演示（改）", description: "演示插件。" } };
  writeFileSync(join(dir, "locale/zh.json"), JSON.stringify(zh, null, 2));
  assert.match(errorsOf(root), /meta\.title 与 scripts\/index-meta\.json 的 title\.zh 不一致/);

  const { root: root2, dir: dir2 } = makeRepo();
  const zh2 = { ...ZH, meta: { title: "演示", description: "另一句描述。" } };
  writeFileSync(join(dir2, "locale/zh.json"), JSON.stringify(zh2, null, 2));
  assert.match(
    errorsOf(root2),
    /meta\.description 与 scripts\/index-meta\.json 的 descriptionZh 不一致/,
  );
});

test("descriptionZh 超过 200 字符时必须截断成它的前缀", () => {
  const long = `${"长".repeat(200)}多出来的一截`;
  const { root, dir } = makeRepo();
  const indexMeta = structuredClone(INDEX_META);
  indexMeta.plugins["@kangyishuai/dsh-demo"].descriptionZh = long;
  writeFileSync(join(root, "scripts/index-meta.json"), JSON.stringify(indexMeta, null, 2));
  const zh = { ...ZH, meta: { title: "演示", description: long.slice(0, 200) } };
  writeFileSync(join(dir, "locale/zh.json"), JSON.stringify(zh, null, 2));
  assert.equal(errorsOf(root), "");

  const zhWrong = { ...ZH, meta: { title: "演示", description: "根本不是前缀" } };
  writeFileSync(join(dir, "locale/zh.json"), JSON.stringify(zhWrong, null, 2));
  assert.match(errorsOf(root), /必须截断成它的前缀/);
});

test("icon：文件存在且进 files 白名单，扩展名与体积、文件头合法", () => {
  // 缺文件
  const a = makeRepo();
  unlinkSync(join(a.dir, "icon.svg"));
  assert.match(errorsOf(a.root), /icon 指向的 icon\.svg 不存在/);

  // 不在 files 白名单
  const b = makeRepo();
  const pkgB = readPkg(b.dir);
  pkgB.files = ["lib", "locale", "README.md", "cordis.patch.yml"];
  writePkg(b.dir, pkgB);
  assert.match(errorsOf(b.root), /icon icon\.svg 不在 files 白名单里/);

  // 超过 256 KiB
  const c = makeRepo();
  writeFileSync(join(c.dir, "icon.svg"), `<svg>${"x".repeat(300 * 1024)}</svg>`);
  assert.match(errorsOf(c.root), /icon icon\.svg 超过宿主上限 256 KiB/);

  // 文件头不是 SVG
  const d = makeRepo();
  writeFileSync(join(d.dir, "icon.svg"), "not an svg");
  assert.match(errorsOf(d.root), /icon icon\.svg 不是合法的 \.svg 文件头/);

  // 宿主不接受 gif
  const e = makeRepo();
  const pkgE = readPkg(e.dir);
  pkgE.icon = "icon.gif";
  pkgE.files = ["lib", "locale", "icon.gif", "README.md", "cordis.patch.yml"];
  writePkg(e.dir, pkgE);
  writeFileSync(join(e.dir, "icon.gif"), Buffer.from("GIF89a"));
  assert.match(errorsOf(e.root), /icon「icon\.gif」的扩展名必须是/);
});

test("合法 PNG 图标通过文件头嗅探", () => {
  const { root, dir } = makeRepo();
  const pkg = readPkg(dir);
  pkg.icon = "icon.png";
  pkg.files = ["lib", "locale", "icon.png", "README.md", "cordis.patch.yml"];
  writePkg(dir, pkg);
  // 8 字节 PNG magic 就够了：真实宿主拿浏览器解码，这里只校验「不是坏文件」。
  writeFileSync(join(dir, "icon.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  assert.equal(errorsOf(root), "");
});

test("已登记索引源的正式插件必须有顶层 icon（删掉字段不再静默跳过身份校验）", () => {
  const { root, dir } = makeRepo();
  const pkg = readPkg(dir);
  // 只删**顶层字段**，icon.svg 文件与 files 白名单都还在：旧实现整段校验挂在
  // `if (pkg.icon !== undefined)` 下，删字段后 0 错（2026-11-28 复审 N2 的复现条件）。
  delete pkg.icon;
  writePkg(dir, pkg);
  assert.match(errorsOf(root), /已登记索引源且版本非 0\.0\.0，必须有 package\.json 顶层 icon/);
});

test("登记但仍为 0.0.0 的脚手架缺 icon 只告警（发版前不变红）", () => {
  const { root, dir } = makeRepo();
  const pkg = readPkg(dir);
  pkg.version = "0.0.0";
  delete pkg.icon;
  writePkg(dir, pkg);
  assert.equal(errorsOf(root), "");
  assert.match(warningsOf(root), /已登记索引源但缺少 package\.json 顶层 icon/);
});

test("未登记索引源的 0.0.0 插件缺 icon 完全豁免（不告警）", () => {
  const { root, dir } = makeRepo({ indexMeta: false });
  const pkg = readPkg(dir);
  pkg.version = "0.0.0";
  delete pkg.icon;
  writePkg(dir, pkg);
  assert.equal(errorsOf(root), "");
  assert.equal(warningsOf(root), "");
});

test("未登记索引源的 0.0.0 插件不强制身份（刚生成、还没登记索引源时不会当场变红）", () => {
  const { root, dir } = makeRepo({ indexMeta: false });
  const pkg = readPkg(dir);
  pkg.version = "0.0.0";
  delete pkg.icon;
  pkg.files = ["lib", "locale", "README.md", "cordis.patch.yml"];
  writePkg(dir, pkg);
  writeFileSync(join(dir, "locale/en.json"), JSON.stringify({ demo: { title: "Demo" } }, null, 2));
  writeFileSync(join(dir, "locale/zh.json"), JSON.stringify({ demo: { title: "演示" } }, null, 2));
  assert.equal(errorsOf(root), "");
});
