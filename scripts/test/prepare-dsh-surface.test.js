// @ts-check
// CI 宿主面的准备脚本（2026-11-28 新增，AUD-XCT-02）。
//
// 旧 CI 里 `probe:runtime` 在 runner 上找不到 app.asar → 打印 SKIP → exit 0，
// 分支保护上的必需检查于是恒绿。新做法：按 AGENTS.md 的目标版本从 npm 装一份宿主面，
// 探针用 --surface 显式指过去；装不出/版本不对都必须非零。这里锁住纯函数部分
// （版本解析 + 就绪判定），安装本身由 CI 真跑验证。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { readTargetVersion, surfaceState } from "../prepare-dsh-surface.mjs";

const scratch = mkdtempSync(join(tmpdir(), "dsh-surface-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("readTargetVersion：读 AGENTS.md 的目标运行时版本", async () => {
  const file = join(scratch, "AGENTS.md");
  writeFileSync(file, "目标运行时：**DSH 桌面版 0.2.2-rc.5**（Electron）\n");
  assert.equal(await readTargetVersion(file), "0.2.2-rc.5");
});

test("readTargetVersion：指针缺失就报错（不能猜一个版本去装）", async () => {
  const file = join(scratch, "AGENTS-bad.md");
  writeFileSync(file, "目标运行时：0.2.2-rc.5\n");
  await assert.rejects(() => readTargetVersion(file), /没找到「目标运行时/);
  await assert.rejects(() => readTargetVersion(join(scratch, "does-not-exist.md")), /读不到/);
});

test("surfaceState：missing / stale / ok 三态", async () => {
  const dir = join(scratch, "surface");
  assert.equal(await surfaceState(dir, "0.2.2-rc.5"), "missing");

  const pkgDir = join(dir, "node_modules", "@deepseek-ai", "dsh");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "0.2.2-rc.3" }));
  assert.equal(await surfaceState(dir, "0.2.2-rc.5"), "stale", "版本不符要重装");

  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ version: "0.2.2-rc.5" }));
  assert.equal(await surfaceState(dir, "0.2.2-rc.5"), "stale", "缺探针文件也算不完整");

  const smokeDir = join(dir, "node_modules", "@deepseek-ai", "dsh-client-ui-chat", "lib");
  mkdirSync(smokeDir, { recursive: true });
  writeFileSync(join(smokeDir, "client.js"), "");
  assert.equal(await surfaceState(dir, "0.2.2-rc.5"), "ok");
});
