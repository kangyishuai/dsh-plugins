// @ts-check
// 产物归档：把外部采集产物接管进项目目录，sha256 长期可复算。
// 背景：产物留在 /tmp，一清理项目就永远停在 investigating（真实踩到过）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createActions } from "../lib/actions.js";
import { CaseStore } from "../lib/core/store.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @returns {{ actions: any, root: string }} */
function makeActions() {
  const root = mkdtempSync(join(tmpdir(), "casefile-artifact-"));
  dirs.push(root);
  return {
    actions: createActions({ store: new CaseStore({ dataRoot: root }), dataRoot: root }),
    root,
  };
}

test("addEvidence 接管产物：落项目目录、sha256 与来源一致", async () => {
  const { actions, root } = makeActions();
  await actions.openProject({ title: "P" });
  const source = join(root, "capture.html");
  const body = "<html>采集产物</html>";
  writeFileSync(source, body, "utf8");

  const evidence = await actions.addEvidence("p", {
    summary: "外部采集快照",
    sourceTool: "scrapling/StealthyFetcher",
    artifactPath: source,
  });

  const expected = createHash("sha256").update(Buffer.from(body)).digest("hex");
  assert.equal(evidence.artifact?.sha256, expected);
  assert.equal(evidence.artifact?.bytes, Buffer.byteLength(body));
  assert.equal(evidence.artifact?.originalName, "capture.html");
  const archived = join(root, "projects", "p", evidence.artifact?.file);
  assert.equal(existsSync(archived), true, "归档文件应存在于项目目录");
  assert.equal(readFileSync(archived, "utf8"), body);
});

test("同一内容重复归档只存一份", async () => {
  const { actions, root } = makeActions();
  await actions.openProject({ title: "P" });
  const source = join(root, "a.html");
  writeFileSync(source, "same-bytes", "utf8");
  const first = await actions.addEvidence("p", { summary: "一", artifactPath: source });
  const second = await actions.addEvidence("p", { summary: "二", artifactPath: source });
  assert.equal(first.artifact?.file, second.artifact?.file);
});

test("产物不存在时报 invalid-input，不静默丢字段", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  await assert.rejects(
    () => actions.addEvidence("p", { summary: "x", artifactPath: "/no/such/file" }),
    (error) => /** @type {any} */ (error).code === "invalid-input",
  );
});

test("不传 artifactPath 时 evidence.artifact 为 null（旧行为不变）", async () => {
  const { actions } = makeActions();
  await actions.openProject({ title: "P" });
  const evidence = await actions.addEvidence("p", { summary: "无产物" });
  assert.equal(evidence.artifact, null);
});
