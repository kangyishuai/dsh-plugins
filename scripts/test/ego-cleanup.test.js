// @ts-check
// ego TaskSpace 清理工具的单测：生成的内层脚本必须语法合法，且只碰 ownership=agent 的空间。
// 不启动 ego-browser、不触碰用户浏览器的任何 TaskSpace。

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkGeneratedSource } from "../check-smoke-browser-scripts.mjs";
import { buildCleanupScript } from "../ego-cleanup.mjs";
import { buildFinishNamedSpaceScript } from "../lib/ego-task-space.mjs";

test("内层脚本语法合法（dry-run / apply 两份都过 node --check）", async () => {
  const work = await mkdtemp(join(tmpdir(), "dsh-ego-cleanup-syntax-"));
  try {
    for (const apply of [false, true]) {
      const source = buildCleanupScript({ apply });
      const path = join(work, `browser-ego-${apply ? "apply" : "dry"}.mjs`);
      await writeFile(path, source, "utf8");
      const result = checkGeneratedSource(source, path);
      assert.equal(result.ok, true, result.detail);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  // 语法检查的返回 detail 在成功时是一句摘要，上面的断言已经覆盖；这里再显式确认 dry-run 不删除。
  const dry = buildCleanupScript({ apply: false });
  assert.doesNotMatch(dry, /=> true/, "dry-run 不应该带 apply 分支");
});

test("只清理 ownership=agent 的空间：user / agentDelegatedToUser 都被跳过", async () => {
  const source = buildCleanupScript({ apply: true });
  assert.match(source, /ownership !== "agent"/u, "必须先按 ownership 过滤");
  assert.match(
    source,
    /!== "agent"[\s\S]*report\.skipped\.push/u,
    "非 agent 空间只进 skipped，不 finish",
  );
  // 只有 agent 分支里才会出现 taskSpace/finish。
  const agentBranch =
    /if \(ownership !== "agent"\)[\s\S]*?continue;[\s\S]*?report\.agentOwned \+= 1;[\s\S]*?taskSpace\(id\)/u;
  assert.match(source, agentBranch);
  // dry-run 连 taskSpace 都不调，避免任何副作用。
  const dry = buildCleanupScript({ apply: false });
  assert.doesNotMatch(dry, /taskSpace\(id\)/u);
  assert.match(dry, /report\.finished\.push\(\{ id, name, dryRun: true \}\)/u);
});

test("apply 模式对每个 agent 空间 finish({ keep: [] })", async () => {
  const source = buildCleanupScript({ apply: true });
  assert.match(source, /await task\.finish\(\{ keep: \[\] \}\)/u);
  assert.match(source, /console\.log\([^)]*EGO_CLEANUP/u, "必须输出可解析的结果行");
});

test("超时兜底的「按名字回收」脚本：限定 ownership=agent 且语法合法", async () => {
  const source = buildFinishNamedSpaceScript("dsh smoke: advisor");
  const work = await mkdtemp(join(tmpdir(), "dsh-ego-reclaim-syntax-"));
  try {
    const path = join(work, "browser-ego-reclaim.mjs");
    await writeFile(path, source, "utf8");
    const result = checkGeneratedSource(source, path);
    assert.equal(result.ok, true, result.detail);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  // 名字用 JSON 编码进脚本（冒烟名里有空格/冒号也不能拼坏）；
  assert.match(source, /const target = "dsh smoke: advisor";/u);
  assert.match(source, /space\.ownership === "agent"/u);
  assert.match(source, /await task\.finish\(\{ keep: \[\] \}\)/u);
});
