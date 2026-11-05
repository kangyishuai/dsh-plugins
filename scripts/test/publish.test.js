// @ts-check
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listPublishable, selectUnpublished } from "../publish.mjs";

const root = mkdtempSync(join(tmpdir(), "publish-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** @param {string} dir @param {object} pkg */
function pkg(dir, pkg) {
  mkdirSync(join(root, "packages", dir), { recursive: true });
  writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify(pkg));
}

test("只挑出非 private、且 registry 上还没有的版本", async () => {
  pkg("a", { name: "@kangyishuai/dsh-a", version: "1.0.0" });
  pkg("b", { name: "@kangyishuai/dsh-b", version: "0.2.0" });
  pkg("c", { name: "@kangyishuai/dsh-c", version: "0.1.0", private: true });
  const targets = listPublishable(root);
  assert.deepEqual(
    targets.map((t) => t.name),
    ["@kangyishuai/dsh-a", "@kangyishuai/dsh-b"],
  );
  const onRegistry = new Set(["@kangyishuai/dsh-a@1.0.0"]);
  const pending = await selectUnpublished(targets, (n, v) => onRegistry.has(`${n}@${v}`));
  assert.deepEqual(pending, [{ dir: "b", name: "@kangyishuai/dsh-b", version: "0.2.0" }]);
});
