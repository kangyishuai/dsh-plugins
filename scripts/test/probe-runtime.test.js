// @ts-check
// 探针的「宿主面」抽象与清单接线（2026-11-28 新增，AUD-XCT-01/02）。
//
// 关键防线：同一份清单必须能在两种宿主面上跑——本机 app.asar（开发用）与 CI 里从 npm
// 装出来的 node_modules（`--surface`）。这里用合成目录锁住目录面的读取/虚拟路径映射，
// 并断言「缺的东西一定 FAIL、种进去的东西一定 PASS」，避免清单写错却全绿。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { openDirectorySurface, readGuestVersion, runProbe } from "../probe-runtime.mjs";

/** @param {string} root @param {string} rel @param {string} body */
function seed(root, rel, body = "") {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
}

/** 建一个最小宿主面：只种探针清单里会被断言的那几条。 */
function makeSurface() {
  const root = mkdtempSync(join(tmpdir(), "dsh-probe-test-"));
  // @deepseek-ai/dsh 的 package.json 提供版本（asar 里是 desktop-runtime，npm 里是 dsh CLI）。
  seed(
    root,
    "@deepseek-ai/dsh/package.json",
    JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.5" }),
  );
  // 服务注册点：宿主用 `super(ctx, "agents")`。
  seed(
    root,
    "@deepseek-ai/dsh-agent/lib/index.js",
    'class A { constructor(ctx) { super(ctx, "agents"); } }',
  );
  // client 服务用 `provide(...)`。
  seed(
    root,
    "@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js",
    "ctx.reflect.provide(`sidebarRight`, controller);",
  );
  // slot：client bundle 里以反引号出现（rc.2 起就是这种形态）。
  seed(
    root,
    "@deepseek-ai/dsh-client-ui-chat/lib/client.js",
    "slots.register({ name: `conversation.chat.turnTail` }); slots.register({ name: `main` });",
  );
  return root;
}

const surfaceRoot = makeSurface();
after(() => rmSync(surfaceRoot, { recursive: true, force: true }));

test("openDirectorySurface：虚拟路径映射到 /dsh/node_modules，且接受父目录", async () => {
  // 传「安装前缀」而不是 node_modules 本身：探针要能自动找到 node_modules/@deepseek-ai。
  const prefix = mkdtempSync(join(tmpdir(), "dsh-probe-prefix-"));
  try {
    mkdirSync(join(prefix, "node_modules"), { recursive: true });
    const real = join(prefix, "node_modules", "@deepseek-ai", "dsh-client-ui-chat", "lib");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "client.js"), "x");
    const surface = await openDirectorySurface(prefix);
    assert.equal(surface.kind, "npm");
    assert.equal(surface.path, join(prefix, "node_modules"));
    assert.ok(
      surface.files.has("/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js"),
      "文件应映射到与 asar 相同的虚拟路径",
    );
    const buffer = await surface.read(
      "/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js",
    );
    assert.equal(buffer?.toString("utf8"), "x");
    assert.equal(
      await surface.read("/dsh/node_modules/@deepseek-ai/does-not-exist/lib/index.js"),
      undefined,
      "不存在的虚拟路径返回 undefined 而不是抛错",
    );
    await surface.close();
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test("readGuestVersion：npm surface 退到 @deepseek-ai/dsh 的版本", async () => {
  const surface = await openDirectorySurface(surfaceRoot);
  assert.equal(await readGuestVersion(surface), "0.2.2-rc.5");
  await surface.close();
});

test("runProbe：种进去的服务/槽 PASS，缺的必需包 FAIL", async () => {
  const surface = await openDirectorySurface(surfaceRoot);
  const { version, results } = await runProbe(surface);
  await surface.close();
  assert.equal(version, "0.2.2-rc.5");

  const byName = new Map(results.map((item) => [item.name, item]));
  const nameOf = (/** @type {string} */ prefix) =>
    [...byName.keys()].find((name) => name.startsWith(prefix));

  // 宿主包缺失必须 FAIL：这是探针的底线，不能因为「文件读不到」就静默跳过。
  assert.equal(byName.get("宿主包 dsh-session-persistence")?.kind, "FAIL");
  // 种进去的服务注册点必须 PASS。
  assert.equal(byName.get("service agents")?.kind, "PASS");
  assert.equal(byName.get("service sidebarRight")?.kind, "PASS");
  // slot 扫描要认反引号形式（rc.5 的 bundle 就是这种）。
  const turnTail = nameOf("slot conversation.chat.turnTail");
  assert.ok(turnTail !== undefined, "turnTail 槽应出现在清单里");
  assert.equal(byName.get(turnTail)?.kind, "PASS");
  // main 这类短名字必须命中 `name:` 上下文；只出现裸反引号不算。
  const mainSlot = nameOf("slot main");
  assert.ok(mainSlot !== undefined);
  assert.equal(byName.get(mainSlot)?.kind, "PASS");

  // 清单完整性哨兵：删掉两个没人用的槽之后，这两个名字不应再出现。
  assert.ok(![...byName.keys()].some((name) => name.startsWith("slot conversation.input.dock")));
  assert.ok(![...byName.keys()].some((name) => name.startsWith("slot conversation.composer")));
  // 4 插件的宿主面必须都在清单里（AUD-XCT-01 的核心：旧探针对它们零覆盖）。
  for (const service of [
    "subagents",
    "tokenMeter",
    "webServer",
    "sessionController",
    "subprocess",
  ]) {
    assert.ok(byName.has(`service ${service}`), `清单应包含 service ${service}`);
  }
});

test("清单里没有重复的检查名（重复会让接线一致性问题被掩盖）", async () => {
  const surface = await openDirectorySurface(surfaceRoot);
  const { results } = await runProbe(surface);
  await surface.close();
  const names = results.map((item) => item.name);
  assert.equal(new Set(names).size, names.length);
});
