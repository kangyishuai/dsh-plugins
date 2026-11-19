// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkDomainConsistency,
  parseArchitectures,
  summarizeAppBundle,
  summarizeInfoPlist,
} from "../lib/core/app-bundle.js";
import {
  buildProvenance,
  capabilityHash,
  parsePackageVersion,
  parseReaVersion,
} from "../lib/core/provenance.js";

const PLIST = {
  CFBundleIdentifier: "com.example.App",
  CFBundleName: "App",
  CFBundleExecutable: "App",
  CFBundleShortVersionString: "1.2.3",
  CFBundleVersion: "456",
  LSMinimumSystemVersion: "12.0",
  LSUIElement: true,
  MMKit_sandboxed: true,
  NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
  CFBundleURLTypes: [{ CFBundleURLSchemes: ["appx"] }],
  CFBundleDocumentTypes: [{ CFBundleTypeExtensions: ["appxplugin"] }],
  UTExportedTypeDeclarations: [{ UTTypeIdentifier: "com.example.app.plugin" }],
};

test("Info.plist 摘要：核心字段与开关都投影出来", () => {
  const s = summarizeInfoPlist(PLIST);
  assert.equal(s.bundleId, "com.example.App");
  assert.equal(s.shortVersion, "1.2.3");
  assert.equal(s.buildVersion, "456");
  assert.equal(s.uiElement, true);
  assert.equal(s.sandboxed, true);
  assert.equal(s.allowsArbitraryLoads, true);
  assert.deepEqual(s.urlSchemes, ["appx"]);
  assert.deepEqual(s.documentExtensions, ["appxplugin"]);
  assert.deepEqual(s.utiPrefixes, ["com.example"]);
});

test("缺字段时给 null / 空数组，不编造", () => {
  const s = summarizeInfoPlist({});
  assert.equal(s.bundleId, null);
  assert.equal(s.sandboxed, null);
  assert.equal(s.allowsArbitraryLoads, null);
  assert.deepEqual(s.exportedUtis, []);
});

test("归属域一致性：一致与不一致都能判出来", () => {
  assert.deepEqual(checkDomainConsistency(summarizeInfoPlist(PLIST)).consistent, true);
  const mismatch = summarizeInfoPlist({
    ...PLIST,
    UTExportedTypeDeclarations: [{ UTTypeIdentifier: "com.other.app.plugin" }],
  });
  const verdict = checkDomainConsistency(mismatch);
  assert.equal(verdict.consistent, false);
  assert.equal(verdict.bundleDomain, "com.example");
  assert.deepEqual(verdict.utiDomains, ["com.other"]);
});

test("归属域不可判时给 null（缺 bundle id 或缺 UTI）", () => {
  assert.equal(
    checkDomainConsistency(summarizeInfoPlist({ UTExportedTypeDeclarations: [] })).consistent,
    null,
  );
});

test("架构解析：fat 与 non-fat 两种 lipo 输出", () => {
  assert.deepEqual(parseArchitectures("x86_64 arm64\n"), ["x86_64", "arm64"]);
  assert.deepEqual(parseArchitectures("Non-fat file: /x is architecture: arm64"), ["arm64"]);
  assert.deepEqual(parseArchitectures(""), []);
});

test("summarizeAppBundle 带出路径与一致性判定", () => {
  const s = summarizeAppBundle(PLIST, {
    architectures: ["arm64"],
    executablePath: "/a/Contents/MacOS/App",
    infoPlistPath: "/a/Contents/Info.plist",
  });
  assert.equal(s.executablePath, "/a/Contents/MacOS/App");
  assert.deepEqual(s.architectures, ["arm64"]);
  assert.equal(s.domainConsistency.consistent, true);
});

test("REA 版本：从 patch 文本与 package.json 解析", () => {
  assert.equal(parseReaVersion('command: ["npx", "-y", "rea-agents@6.9.0"]'), "6.9.0");
  assert.equal(parseReaVersion("no version here"), null);
  assert.equal(parsePackageVersion('{"version":"6.9.0"}'), "6.9.0");
  assert.equal(parsePackageVersion("not json"), null);
});

test("工具面哈希：名字集合相同即相同，顺序无关", () => {
  const a = capabilityHash(["mcp__rea__a", "mcp__rea__b"]);
  const b = capabilityHash(["mcp__rea__b", "mcp__rea__a", "mcp__rea__a"]);
  assert.equal(a, b);
  assert.notEqual(a, capabilityHash(["mcp__rea__a"]));
  assert.equal(a.length, 16);
});

test("buildProvenance：没有版本时留 null，但哈希始终可算", () => {
  const p = buildProvenance({ toolNames: ["mcp__rea__x"], reaVersion: null });
  assert.equal(p.reaVersion, null);
  assert.equal(p.reaToolCount, 1);
  assert.match(p.capabilityHash, /^[a-f0-9]{16}$/u);
  assert.match(p.probedAt, /^\d{4}-/u);
});

test("inspectAppBundle 用 plutil 把 XML Info.plist 转成 JSON（真实踩到的 bug）", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createActions } = await import("../lib/actions.js");
  const { CaseStore } = await import("../lib/core/store.js");

  const root = mkdtempSync(join(tmpdir(), "app-bundle-"));
  const appDir = join(root, "Demo.app");
  const contents = join(appDir, "Contents");
  const macos = join(contents, "MacOS");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(contents, { recursive: true });
  mkdirSync(macos, { recursive: true });
  writeFileSync(join(macos, "Demo"), "not-a-real-binary", "utf8");
  // 故意写 XML plist：直接 JSON.parse 会炸
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.demo.app</string>
<key>CFBundleExecutable</key><string>Demo</string>
<key>CFBundleShortVersionString</key><string>9.9.9</string>
<key>LSUIElement</key><true/>
</dict></plist>`,
    "utf8",
  );

  const runner = async (/** @type {string} */ command) => {
    // 用真实 plutil 转换，模拟宿主里的 runner
    const { execFileSync } = await import("node:child_process");
    const match = command.match(/plutil -convert json -o - "(.+)"/u);
    const path = match ? match[1] : "";
    try {
      const out = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
        encoding: "utf8",
      });
      return { exitCode: 0, stdout: out, stderr: "" };
    } catch {
      return { exitCode: 1, stdout: "", stderr: "plutil failed" };
    }
  };

  const actions = createActions({
    store: new CaseStore({ dataRoot: root }),
    dataRoot: root,
    runner,
  });
  const summary = await actions.inspectAppBundle({ path: appDir });
  assert.equal(summary.bundleId, "com.demo.app");
  assert.equal(summary.shortVersion, "9.9.9");
  assert.equal(summary.uiElement, true);
});
