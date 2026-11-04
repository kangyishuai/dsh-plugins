// @ts-check
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  encodeSegment,
  isInside,
  isSafeSessionId,
  projectKey,
  requireInside,
  resolveDataRoot,
} from "../lib/paths.js";

test("resolveDataRoot 优先级：配置 > DSH_HOME > ~/.dsh", () => {
  assert.equal(resolveDataRoot({ dataRoot: "/tmp/x" }, {}, "/home/u"), resolve("/tmp/x"));
  assert.equal(resolveDataRoot({}, { DSH_HOME: "/tmp/env" }, "/home/u"), resolve("/tmp/env"));
  assert.equal(resolveDataRoot({}, {}, "/home/u"), join("/home/u", ".dsh"));
  assert.equal(resolveDataRoot(undefined, {}, "/home/u"), join("/home/u", ".dsh"));
});

test("会话 id 校验挡住路径穿越", () => {
  assert.equal(isSafeSessionId("session-abc"), true);
  assert.equal(isSafeSessionId("0f0f0f"), true);
  assert.equal(isSafeSessionId("../etc/passwd"), false);
  assert.equal(isSafeSessionId(".hidden"), false);
  assert.equal(isSafeSessionId(""), false);
  assert.equal(isSafeSessionId(42), false);
});

test("encodeSegment 与宿主 JSONL 后端规则一致", () => {
  assert.equal(encodeSegment("session-abc"), "session-abc");
  assert.equal(encodeSegment("a/b"), "a~002Fb");
  assert.equal(encodeSegment("."), "~002E");
  assert.equal(encodeSegment(".."), "~002E~002E");
  assert.equal(encodeSegment("a~b"), "a~007Eb");
});

test("projectKey 把分隔符压成 -", () => {
  assert.equal(projectKey("/Users/me/proj"), "--Users-me-proj--");
  assert.equal(projectKey("C:\\work\\x"), "--C-work-x--");
  assert.equal(projectKey("/"), "--root--");
});

test("isInside / requireInside 拒绝逃逸", () => {
  assert.equal(isInside("/data", "/data/sessions/a"), true);
  assert.equal(isInside("/data", "/data"), true);
  assert.equal(isInside("/data", "/datax/a"), false);
  assert.equal(isInside("/data", "/etc/passwd"), false);
  assert.throws(() => requireInside("/data", "/etc/passwd"), /outside the DSH data root/);
  assert.equal(requireInside("/data", "/data/sessions"), "/data/sessions");
});
