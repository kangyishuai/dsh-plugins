// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCapabilities, probeCapabilities } from "../lib/capability.js";

/** @param {Record<string, any>} services */
function ctxWith(services) {
  return {
    get: (/** @type {string} */ name) => services[name],
    parallel: () => {},
    waterfall: () => {},
  };
}

test("缺核心接口时是 unknown（只读模式）", () => {
  const caps = probeCapabilities(ctxWith({}));
  assert.equal(caps.tier, "unknown");
  assert.ok(caps.notes.includes("missing: persistence.stat"));
  assert.equal(describeCapabilities(caps).tier, "unknown");
});

test("核心齐全但缺 locate / storageDomain 时是 internal", () => {
  const caps = probeCapabilities(
    ctxWith({
      sessionPersistence: { stat() {} },
      workspaceRegistry: { archiveSession() {}, unarchiveSession() {} },
    }),
  );
  assert.equal(caps.tier, "internal");
  assert.equal(caps.checks["persistence.locate"], false);
});

test("缺少 persistence.list 时降级为 internal（体检不可用）", () => {
  const caps = probeCapabilities(
    ctxWith({
      sessionPersistence: { stat() {}, locate() {} },
      workspaceRegistry: { archiveSession() {}, unarchiveSession() {} },
    }),
  );
  assert.equal(caps.tier, "internal");
  assert.equal(caps.checks["persistence.list"], false);
});

test("全部齐全时是 api", () => {
  const caps = probeCapabilities(
    ctxWith({
      sessionPersistence: { stat() {}, locate() {}, list() {} },
      sessions: { get() {}, flush() {}, detachEntered() {}, store: new Map() },
      workspaceRegistry: {
        archiveSession() {},
        unarchiveSession() {},
        pinSession() {},
        unpinSession() {},
        list() {},
      },
      storageDomain: { get() {} },
      agents: { detachEntered() {}, store: new Map() },
    }),
  );
  assert.equal(caps.tier, "api");
  assert.deepEqual(caps.notes, []);
});
