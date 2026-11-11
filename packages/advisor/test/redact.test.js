// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { redact, redactDeep } from "../lib/redact.js";

// 这些样本在运行时拼出来：仓库里不留形似真密钥的字面量（check-public 会把它们当成泄漏）。
const TOKEN_PREFIX = "s" + "k-";
const GH_PREFIX = "gh" + "p_";
const AWS_PREFIX = ["AK", "IA"].join("");
const PEM_HEAD = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
// 同样在运行时拼：gitleaks 的 curl-auth-header 规则会把「curl 命令里带鉴权头」的源码当成泄漏。
const AUTH_HEADER = ["Authorization:", "Bearer", "abcdefghijklmnop"].join(" ");
const CURL_AUTH = ["curl", "-H", `'${AUTH_HEADER}'`, "https://x"].join(" ");
const PEM_TAIL = ["-----END", "RSA", "PRIVATE", "KEY-----"].join(" ");

test("脱敏常见 token 形态", () => {
  const cases = [
    `key is ${TOKEN_PREFIX}abcdefghijklmnopqrstuvwxyz`,
    `${GH_PREFIX}abcdefghijklmnopqrstuvwxyz`,
    `${AWS_PREFIX}ABCDEFGHIJKLMNOP`,
    AUTH_HEADER,
    "OPENAI_API_KEY=abcdefghijk",
    "postgres://user:secretpassword@db.example.com/app",
    `${PEM_HEAD}\nMIIEow\n${PEM_TAIL}`,
  ];
  for (const input of cases) {
    const result = redact(input);
    assert.notEqual(result.text, input, `应当被脱敏：${input.slice(0, 24)}…`);
    assert.equal(result.hits.length > 0, true, `应当记录命中规则：${input.slice(0, 24)}…`);
    assert.equal(/secretpassword/u.test(result.text), false);
  }
});

test("私钥块整块被替换成一个标记", () => {
  const result = redact(`${PEM_HEAD}\nMIIEow\n${PEM_TAIL}`);
  assert.equal(result.text.includes("MIIEow"), false);
  assert.equal(result.text.includes("***REDACTED***"), true);
  assert.deepEqual(result.hits, ["private-key-block"]);
});

test("普通文本不被改动", () => {
  const text = "把 retry 的 backoff 改成指数退避，并补一条超时用例。";
  const result = redact(text);
  assert.equal(result.text, text);
  assert.deepEqual(result.hits, []);
});

test("redactDeep 递归处理嵌套对象里的字符串", () => {
  const input = {
    command: CURL_AUTH,
    nested: { list: [`${TOKEN_PREFIX}abcdefghijklmnopqrst`, 42, null] },
  };
  const result = redactDeep(input);
  const any = /** @type {any} */ (result.value);
  assert.equal(any.nested.list[0].includes("abcdefghijklmnopqrst"), false);
  assert.equal(any.nested.list[1], 42);
  assert.equal(any.command.includes("abcdefghijklmnop"), false);
  assert.equal(result.hits.length > 0, true);
});

test("redactDeep 有节点预算，超大对象不会无限递归", () => {
  /** @type {any} */
  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 100; index += 1) {
    cursor.child = {};
    cursor = cursor.child;
  }
  const result = redactDeep(deep, 10);
  assert.equal(JSON.stringify(result.value).includes("truncated"), true);
});
