// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, name } from "../lib/index.js";

/** @returns {DSH.HostContext & { logs: unknown[][] }} */
function fakeContext() {
  /** @type {unknown[][]} */
  const logs = [];
  const log = (/** @type {unknown[]} */ ...args) => {
    logs.push(args);
  };
  return { logs, logger: { info: log, warn: log, error: log } };
}

test("apply() 能在最小 ctx 上加载", () => {
  const ctx = fakeContext();
  apply(ctx);
  assert.equal(name, "__NAME__");
  assert.equal(ctx.logs.length, 1);
});
