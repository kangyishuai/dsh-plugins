// @ts-check
// 净室 attestation：记录投喂内容与「不要读原件」的要求，且必须诚实标注工具面未隔离。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import {
  attestationSummary,
  buildAttestation,
  CLEAN_ROOM_CLAUSE,
} from "../lib/core/attestation.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @returns {ReturnType<typeof createActions>} */
function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-att-"));
  dirs.push(root);
  return createActions({
    store: new CaseStore({ dataRoot: root }),
    dataRoot: root,
    sessions: {
      create: async () => ({ sessionId: "sess-att" }),
      prompt: async () => {},
      wait: async () => ({ reason: "idle", output: null }),
    },
  });
}

test("buildAttestation：默认 prompt 含净室指令，且如实标注工具面未隔离", () => {
  const attestation = buildAttestation({
    project: { authTier: "authorized" },
    prompt: `你在做一次复刻。${CLEAN_ROOM_CLAUSE}。`,
    pack: { claims: [{ id: "c1" }], evidence: [{ id: "e1" }, { id: "e2" }] },
    sessionId: "sess-1",
    builderId: "builder-1",
  });
  assert.equal(attestation.cleanRoomInstruction, true);
  assert.equal(attestation.claimCount, 1);
  assert.equal(attestation.evidenceCount, 2);
  assert.match(String(attestation.toolIsolation), /none/u);
  assert.match(String(attestation.statement), /不构成净室证明|不保证/u);
  assert.equal(attestation.promptDigest.length, 64);
});

test("buildAttestation：prompt 里没有净室指令时如实记 false", () => {
  const attestation = buildAttestation({
    project: { authTier: "research" },
    prompt: "随便写点什么",
    pack: { claims: [], evidence: [] },
    sessionId: "s",
    builderId: "b",
  });
  assert.equal(attestation.cleanRoomInstruction, false);
});

test("startBuilder 写 attestation，且能读回", async () => {
  const actions = makeActions();
  await actions.openProject({ title: "Att", authTier: "authorized" });
  const claim = await actions.addClaim("att", { text: "x" });
  await actions.selectClaims("att", [claim.id], true);
  const started = await actions.startBuilder("att", { cwd: "/tmp/impl" });
  assert.match(String(started.attestation?.promptDigest), /^[0-9a-f]{12}$/u);
  const detail = await actions.detail("att");
  assert.equal(detail.attestations.length, 1);
  assert.equal(detail.attestations[0].cleanRoomInstruction, true);
});

test("attestationSummary 取最近一条并带上声明", () => {
  const summary = attestationSummary([
    { at: "2026-01-01T00:00:00.000Z", sessionId: "old", claimCount: 1 },
    { at: "2026-02-01T00:00:00.000Z", sessionId: "new", claimCount: 2, promptDigest: "x" },
  ]);
  assert.equal(summary?.builderSession, "new");
  assert.equal(summary?.count, 2);
  assert.equal(attestationSummary([]), null);
});

test("报告 md 包含净室 attestation 小节", async () => {
  const actions = makeActions();
  const project = await actions.openProject({ title: "AttReport", authTier: "authorized" });
  const claim = await actions.addClaim(project.id, { text: "x" });
  await actions.selectClaims(project.id, [claim.id], true);
  await actions.startBuilder(project.id, { cwd: "/tmp/impl" });
  const exported = await actions.exportReport(project.id);
  const md = readFileSync(join(exported.path, "report.md"), "utf8");
  assert.match(md, /## 净室 attestation/u);
  assert.match(md, /净室指令写入 prompt：是/u);
  assert.match(md, /工具面隔离：none/u);
  const json = JSON.parse(readFileSync(join(exported.path, "report.json"), "utf8"));
  assert.equal(json.cleanRoom.cleanRoomInstruction, true);
});
