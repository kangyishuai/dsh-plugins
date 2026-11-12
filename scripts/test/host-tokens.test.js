// @ts-check
// 主题 token 规则的单测：插件 CSS 里写错 token 名字 / 写死白色前景都必须被拦下来。
// 用临时目录 + 手搓一个最小插件，避免依赖真实插件内容。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkRepo } from "../check-plugins.mjs";
import { extractTokens, readSnapshot } from "../host-tokens.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-plugins-tokens-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** 造一个能通过其余检查、只在 client CSS 上有差异的最小插件。 */
function makePlugin(/** @type {string} */ name, /** @type {string} */ css) {
  const base = join(root, "packages", name);
  mkdirSync(join(base, "lib"), { recursive: true });
  mkdirSync(join(base, "locale"), { recursive: true });
  writeFileSync(join(base, "LICENSE"), "MIT\n");
  writeFileSync(join(base, "README.md"), "# x\n");
  writeFileSync(join(base, "README.zh-CN.md"), "# x\n");
  writeFileSync(
    join(base, "cordis.patch.yml"),
    `- id: ${name}\n  name: "@kangyishuai/dsh-${name}"\n`,
  );
  writeFileSync(
    join(base, "package.json"),
    JSON.stringify({
      name: `@kangyishuai/dsh-${name}`,
      version: "0.0.0",
      type: "module",
      license: "MIT",
      publishConfig: { access: "public" },
      repository: {
        url: "git+https://github.com/kangyishuai/dsh-plugins.git",
        directory: `packages/${name}`,
      },
      dsh: { bundle: { patch: "cordis.patch.yml" }, client: { platform: "web" } },
    }),
  );
  writeFileSync(
    join(base, "lib", "client.js"),
    `window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-${name}",
  factory() {
    const style = document.createElement("style");
    style.textContent = ${JSON.stringify(css)};
    document.head.appendChild(style);
    return {};
  },
});
`,
  );
  writeFileSync(join(base, "locale", "zh.json"), JSON.stringify({ [name]: { a: "a" } }));
  writeFileSync(join(base, "locale", "en.json"), JSON.stringify({ [name]: { a: "a" } }));
  return base;
}

/**
 * 只取「主题 token」相关的结论：临时目录里没有根 package.json 的脚本登记，
 * 其余规则（桌面套件、labeler 等）会顺带报错，与本用例无关。
 * @param {string} plugin
 */
function messagesOf(plugin) {
  return checkRepo(root)
    .filter((issue) => issue.plugin === plugin)
    .filter((issue) => /主题 token|把白写死/u.test(issue.message))
    .map((issue) => `${issue.level}: ${issue.message}`);
}

test("快照本身可用：抽到的 token 是真实存在的那批", () => {
  const { tokens } = readSnapshot();
  assert.ok(tokens.length > 300, `快照只有 ${tokens.length} 个 token，明显不对`);
  // 这几组是本仓库真正用到的、也是最容易踩的
  for (const token of [
    "--dsw-alias-brand-primary",
    "--dsw-alias-label-primary-foreground",
    "--dsw-alias-state-warn-label",
    "--dsw-alias-state-warn-primary",
    "--ds-font-family-code",
  ]) {
    assert.ok(tokens.includes(token), `快照缺少 ${token}`);
  }
});

test("插件用宿主存在的 token → 通过", () => {
  makePlugin("tok-ok", ".a{color:var(--dsw-alias-label-primary,#000);}");
  assert.deepEqual(messagesOf("tok-ok"), []);
});

test("写错 token 名 → error（会静默落到硬编码兜底色）", () => {
  // 宿主真名是 --dsw-alias-state-warn-primary，这是 0.5.0 真实踩过的笔误
  makePlugin("tok-typo", ".a{color:var(--dsw-alias-state-warning-primary,#b7791f);}");
  const messages = messagesOf("tok-typo");
  assert.equal(messages.length, 1, messages.join("\n"));
  assert.match(messages[0], /^error: .*lib\/client\.js:5 用了宿主不存在的主题 token/u);
  assert.match(messages[0], /state-warning-primary/u);
});

test("把白写死当前景色 → warn（底色翻主题时会糊）", () => {
  makePlugin("tok-white", ".a{background:var(--dsw-alias-state-error-primary);color:#fff;}");
  const messages = messagesOf("tok-white");
  assert.equal(messages.length, 1, messages.join("\n"));
  assert.match(messages[0], /^warn: .*把白写死当前景色/u);
});

test("var() 兜底参数里的白不算问题", () => {
  makePlugin("tok-fallback", ".a{color:var(--dsw-alias-label-primary-foreground,#fff);}");
  assert.deepEqual(messagesOf("tok-fallback"), []);
});

test("模板目录同样受检查", () => {
  // templates 里放一个坏 token，应报在 plugin=templates 下
  const dir = join(root, "templates", "plugin", "lib");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "client.js"), 'const css = ".x{color:var(--dsw-alias-nope-primary)}";\n');
  const messages = checkRepo(root)
    .filter((issue) => issue.plugin === "templates")
    .filter((issue) => /主题 token|把白写死/u.test(issue.message))
    .map((issue) => `${issue.level}: ${issue.message}`);
  assert.equal(messages.length, 1, messages.join("\n"));
  assert.match(messages[0], /--dsw-alias-nope-primary/u);
});

test("extractTokens 对不存在的 asar 给出可读错误", () => {
  assert.throws(() => extractTokens(join(root, "no-such-app.asar")), /找不到 .*no-such-app\.asar/u);
});
