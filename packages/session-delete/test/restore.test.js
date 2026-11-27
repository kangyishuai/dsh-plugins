// @ts-check
// AUD-SD-02：恢复后的校验要如实反映结果，同时不能把「宿主还没 flush」误报成失败。
// 置顶集合只能读 storages/workspace.json（宿主持久化可能滞后），所以 pin 校验读两次。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyRestored } from "../lib/restore.js";

/**
 * @param {{ pinned?: (boolean | null)[] }} [options]
 * @returns {import("../lib/refs.js").RefAdapter[]}
 */
function fakeRefs(options = {}) {
  const pinValues = [...(options.pinned ?? [true])];
  return [
    {
      id: "workspace-slot",
      label: "工作区记账",
      tier: "api",
      snapshot: async () => ({ workspaceIds: ["ws1"] }),
    },
    {
      id: "workspace-pin",
      label: "置顶标记",
      tier: "api",
      snapshot: async () => ({ pinned: pinValues.length > 1 ? pinValues.shift() : pinValues[0] }),
    },
  ];
}

/** @returns {Promise<string>} */
async function restoreDir() {
  return mkdtemp(join(tmpdir(), "dsh-sdel-restore-"));
}

test("校验：目录回来、工作区与置顶都还原时报全绿", async () => {
  const dir = await restoreDir();
  const checks = await verifyRestored({
    refs: fakeRefs(),
    sessionId: "session-abc",
    restoredTo: dir,
    meta: { workspaceIds: ["ws1"], pinned: true },
  });
  assert.equal(checks.find((item) => item.id === "session-dir")?.status, "ok");
  assert.equal(checks.find((item) => item.id === "workspace-slot")?.status, "ok");
  assert.equal(checks.find((item) => item.id === "workspace-pin")?.status, "ok");
  await rm(dir, { recursive: true, force: true });
});

test("校验：置顶写入滞后（第一次读到 false、第二次 true）不算失败", async () => {
  const dir = await restoreDir();
  const checks = await verifyRestored({
    refs: fakeRefs({ pinned: [false, true] }),
    sessionId: "session-abc",
    restoredTo: dir,
    meta: { workspaceIds: [], pinned: true },
  });
  assert.equal(checks.find((item) => item.id === "workspace-pin")?.status, "ok");
  assert.equal(checks.find((item) => item.id === "workspace-slot")?.status, "skipped");
  await rm(dir, { recursive: true, force: true });
});

test("校验：置顶确实没恢复时报 failed，读不到集合时报 skipped", async () => {
  const dir = await restoreDir();
  const failed = await verifyRestored({
    refs: fakeRefs({ pinned: [false] }),
    sessionId: "session-abc",
    restoredTo: dir,
    meta: { workspaceIds: [], pinned: true },
  });
  assert.equal(failed.find((item) => item.id === "workspace-pin")?.status, "failed");

  const unknown = await verifyRestored({
    refs: fakeRefs({ pinned: [null] }),
    sessionId: "session-abc",
    restoredTo: dir,
    meta: { workspaceIds: [], pinned: true },
  });
  assert.equal(unknown.find((item) => item.id === "workspace-pin")?.status, "skipped");
  await rm(dir, { recursive: true, force: true });
});

test("校验：工作区没挂回去时报 failed", async () => {
  const dir = await restoreDir();
  const checks = await verifyRestored({
    refs: [
      {
        id: "workspace-slot",
        label: "工作区记账",
        tier: "api",
        snapshot: async () => ({ workspaceIds: [] }),
      },
    ],
    sessionId: "session-abc",
    restoredTo: dir,
    meta: { workspaceIds: ["ws1"], pinned: false },
  });
  const slot = checks.find((item) => item.id === "workspace-slot");
  assert.equal(slot?.status, "failed");
  assert.match(String(slot?.detail), /ws1/u);
  await rm(dir, { recursive: true, force: true });
});
