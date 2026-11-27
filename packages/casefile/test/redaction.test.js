// @ts-check
// 脱敏覆盖范围（AUD-CASEFILE-05）：负向断言——遮完不能再出现这些形态。
//
// 背景：redactText 只覆盖 5 个绝对路径前缀与 6 类 token；而 case_app inspect 会把
// `/Applications/Foo.app` 原样写进 refs，规格包「默认脱敏」因此名不副实。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  buildSpecPack,
  redactPack,
  redactText,
  renderSpecMarkdown,
  writeSpecPack,
} from "../lib/core/brief.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @param {string} text */
function redact(text) {
  return redactText(text, { home: "/Users/me", cwd: "/Users/me/work" });
}

/**
 * 测试用假凭据：**运行时拼接**，源码里不出现完整 token 形态。
 * 原因：CI 的 gitleaks 扫描 PR 全部 commit，完整字面量即使只是 fixture 也会命中
 * `jwt` / `private-key` / `npm` / `aws-access-token` 等规则（分支历史里同样不能有）。
 * @param {...string} parts
 * @returns {string}
 */
function fake(...parts) {
  return parts.join("");
}

test("任意绝对路径都被遮：/Applications、/Volumes、/opt、/etc、/Library、/usr", () => {
  const paths = [
    "/Applications/Foo.app",
    "/Volumes/Ext/report.har",
    "/opt/homebrew/bin/tool",
    "/etc/hosts",
    "/Library/Preferences/com.foo.plist",
    "/usr/local/bin/node",
  ];
  const out = redact(`读到 ${paths.join("、")} 这六个位置`);
  for (const path of paths) {
    assert.equal(out.includes(path), false, `未遮：${path} → ${out}`);
  }
  assert.match(out, /<path>/u);
  assert.equal(out.split("<path>").length - 1, paths.length, "每个路径都应被替换");
});

test("未展开的 ~ 路径也被遮", () => {
  const out = redact("路径：~/Documents/case-notes.md 与 ~/Library/Logs/a.log");
  assert.equal(out.includes("~/Documents"), false, out);
  assert.equal(out.includes("~/Library"), false, out);
  assert.match(out, /<path>/u);
});

test("未知根目录但带扩展名的绝对路径也被遮（B2 回归）", () => {
  const paths = [
    "/custom/dir/report.pdf",
    "/myroot/secret/data.json",
    "/static/app.js",
    "/work/output.har",
    "/a.b",
  ];
  const out = redact(`看 ${paths.join("、")} 这几个位置`);
  for (const path of paths) {
    assert.equal(out.includes(path), false, `未遮：${path} → ${out}`);
  }
  assert.equal(out.split("<path>").length - 1, paths.length, "每个路径都应被替换");
});

test("不带扩展名的 API 路由仍保持可读（避免把规格包遮成噪声）", () => {
  const out = redact("POST /api/todos 与 /auth/token 都可用，状态码 201");
  assert.match(out, /\/api\/todos/u);
  assert.match(out, /\/auth\/token/u);
  assert.match(out, /201/u);
});

test("URL 保持原样（不能被绝对路径规则吃掉）", () => {
  const out = redact("目标 https://example.test/api/todos?id=1 与 http://127.0.0.1:9223/ 可用");
  assert.match(out, /https:\/\/example\.test\/api\/todos\?id=1/u);
  assert.match(out, /http:\/\/127\.0\.0\.1:9223\//u);
});

test("常见 token 形态补全：AIza / ASIA / npm_ / JWT / 私钥块 / password=", () => {
  const samples = [
    fake("AIza", "SyD-example-0123456789abcdefghij"),
    fake("ASIA", "IOSFODNN7EXAMPLE"),
    fake("npm_", "abcdefghijklmnopqrstuvwxyz0123456789"),
    [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ].join("."),
    [
      fake("-----BEGIN", " RSA PRIVATE KEY-----"),
      "MIIEowIBAAKCAQEAxyz",
      fake("-----END", " RSA PRIVATE KEY-----"),
    ].join("\n"),
  ];
  for (const sample of samples) {
    const out = redact(`值：${sample}`);
    assert.equal(out.includes(sample.split("\n")[0]), false, `未遮 token：${sample.slice(0, 20)}`);
    assert.match(out, /\[redacted\]/u);
  }
  const password = redact(
    `配置 password=hunter2 与 api_key=${fake("sk-live-", "abcdefghijklmnop")}`,
  );
  assert.equal(password.includes("hunter2"), false, password);
  assert.match(password, /\[redacted\]/u);
});

test("原有关键路径与 token 仍被遮（正例不回归）", () => {
  const fakeSk = fake("sk-", "abcdefghijklmnop1234");
  const fakeGhp = fake("ghp_", "abcdefghijklmnopqrstu");
  const fakeBearer = fake("Bearer ", "abcdefghijklmnopqrstuvwxyz");
  const out = redact(`读到 /Users/me/secret/app.bin、${fakeSk}、${fakeGhp}（${fakeBearer}）`);
  assert.equal(out.includes("/Users/me"), false);
  assert.equal(out.includes(fakeSk), false);
  assert.equal(out.includes(fakeGhp), false);
  assert.equal(out.includes("abcdefghijklmnopqrstuvwxyz"), false);
});

test("redactPack 对嵌套 refs 逐条生效（规格包导出即脱敏）", () => {
  const redacted = redactPack(
    {
      project: { target: { ref: "/Applications/Foo.app" } },
      evidence: [
        {
          refs: ["/Volumes/Ext/x.har"],
          summary: `调用 ${fake("AIza", "SyD-example-0123456789abcdefghij")}`,
        },
      ],
    },
    { home: "/Users/me", cwd: "/Users/me/work" },
  );
  const text = JSON.stringify(redacted);
  assert.equal(text.includes("/Applications/Foo.app"), false, text);
  assert.equal(text.includes("/Volumes/Ext/x.har"), false, text);
  assert.equal(text.includes("AIzaSyD"), false, text);
  assert.match(text, /<path>/u);
});

test("writeSpecPack 默认脱敏：落盘的 spec.json / brief.md 不含 /Applications", () => {
  const root = mkdtempSync(join(tmpdir(), "casefile-redact-"));
  dirs.push(root);
  const pack = buildSpecPack({
    project: {
      id: "p",
      title: "P",
      target: { kind: "app", ref: "/Applications/Foo.app" },
      authTier: "owned",
      scope: "all",
    },
    claims: [
      {
        id: "c1",
        text: "应用包可读",
        kind: "structure",
        status: "observed",
        limitations: [],
        evidenceIds: [],
        featureIds: [],
        selected: true,
      },
    ],
    evidence: [],
    features: [],
    unknowns: [],
  });
  const written = writeSpecPack({ projectDir: root, pack });
  const spec = readFileSync(join(written.dir, "spec.json"), "utf8");
  const brief = readFileSync(join(written.dir, "brief.md"), "utf8");
  for (const file of [spec, brief]) {
    assert.equal(file.includes("/Applications/Foo.app"), false, file.slice(0, 200));
    assert.match(file, /<path>/u);
  }
  // redact:false 时保持原样（导出确实可以选择不脱敏）
  const raw = writeSpecPack({ projectDir: root, pack, redact: false });
  assert.match(readFileSync(join(raw.dir, "spec.json"), "utf8"), /\/Applications\/Foo\.app/u);
  assert.match(renderSpecMarkdown(pack), /\/Applications\/Foo\.app/u);
});
