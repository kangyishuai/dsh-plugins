// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkFiles } from "../check-public.mjs";

const root = mkdtempSync(join(tmpdir(), "check-public-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** @param {string} file @param {string} content */
function put(file, content) {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), content);
}

/** @param {string} file */
const rules = (file) => checkFiles(root, [file]).map((f) => f.rule);

test("拦截 notes/ 文件与链接", () => {
  put("notes/a.md", "x");
  assert.deepEqual(rules("notes/a.md"), ["notes-tracked"]);
  put("docs/a.md", `见 [调研](${"../no"}tes/session-delete/README.md)\n`); // 拆开写，免得本文件被检查命中
  assert.deepEqual(rules("docs/a.md"), ["notes-link"]);
  put("docs/b.md", "调研笔记放在 notes/ 目录\n");
  assert.deepEqual(rules("docs/b.md"), []);
});

test("拦截真实用户名路径，放行占位用户名", () => {
  const user = ["kang", "yishuai"].join(""); // 避免本文件自身被检查命中
  put("a.js", `const p = "/Users/${user}/proj";\n`);
  assert.deepEqual(rules("a.js"), ["home-path"]);
  put("b.js", `const p = "C:\\\\Users\\\\${user}\\\\x";\n`);
  assert.deepEqual(rules("b.js"), ["home-path"]);
  put("c.js", 'const p = "/Users/me/proj"; const q = "/home/runner/work";\n');
  assert.deepEqual(rules("c.js"), []);
  put("d.js", `const p = "/home/${user}/x"; // check-public: allow 测试夹具\n`);
  assert.deepEqual(rules("d.js"), []);
});

test("拦截 token、私钥与 .env", () => {
  const token = `ghp_${"a".repeat(36)}`;
  put("e.md", `token: ${token}\n`);
  assert.deepEqual(rules("e.md"), ["secret"]);
  put("f.pem", `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----\n`);
  assert.deepEqual(rules("f.pem"), ["secret"]);
  put(".env", "A=1");
  assert.deepEqual(rules(".env"), ["env-file"]);
  put(".env.example", "A=");
  assert.deepEqual(rules(".env.example"), []);
});
