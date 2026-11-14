// @ts-check
// automerge 分级判定的单测：规则本身在 CONTRIBUTING §自动合并分级 / ADR 0014 里，
// 这里把「什么算合规」钉成可执行断言（workflow 见 .github/workflows/automerge-guard.yml）。
import assert from "node:assert/strict";
import test from "node:test";
import { evaluate, fileAllowed, tierOf } from "../automerge-guard.mjs";

const REPO = "kangyishuai/dsh-plugins";

/** @param {Partial<Parameters<typeof evaluate>[0]>} overrides */
const pull = (overrides = {}) => ({
  repo: REPO,
  title: "docs: 补一条说明",
  headRef: "docs/repo-note",
  headRepo: REPO,
  labels: ["automerge"],
  changesRequested: 0,
  files: ["docs/testing/next-step.md"],
  ...overrides,
});

test("档位：release 只认 changeset-release/main", () => {
  assert.deepEqual(tierOf("chore(release): version packages", "changeset-release/main"), {
    kind: "release",
    tier: "A",
  });
  assert.equal(tierOf("chore(release): version packages", "docs/whatever"), null);
});

test("档位：docs / test / chore(repo) 属于 B 档文档，feat 与跨包不在 A/B 档", () => {
  assert.equal(tierOf("docs: x", "docs/a")?.kind, "docs");
  assert.equal(tierOf("test: x", "test/a")?.kind, "docs");
  assert.equal(tierOf("chore(repo): x", "chore/a")?.kind, "docs");
  assert.equal(tierOf("feat(next-step): x", "feat/next-step-a"), null);
  assert.equal(tierOf("chore(release): x", "changeset-release/main"), null);
});

test("档位：带 scope 的 docs(<plugin>): 也算文档档", () => {
  assert.equal(tierOf("docs(next-step): 补发布记录", "docs/next-step-0-4-1")?.kind, "docs");
  assert.equal(
    evaluate(
      pull({ title: "docs(next-step): 补发布记录", files: ["packages/next-step/README.md"] }),
    ).ok,
    true,
  );
  // 但路径白名单照旧：文档档仍然不许碰源码
  assert.equal(
    evaluate(pull({ title: "docs(next-step): x", files: ["packages/next-step/lib/client.js"] })).ok,
    false,
  );
});

test("档位：fix/test 带插件 scope 才是单插件档", () => {
  assert.deepEqual(tierOf("fix(next-step): 卡片晚到", "fix/next-step-card"), {
    kind: "code",
    tier: "B · 单插件",
  });
  assert.equal(tierOf("test(advisor): x", "test/advisor-a")?.kind, "code");
  assert.equal(tierOf("fix: 没写 scope", "fix/a"), null);
  assert.equal(tierOf("fix(next-step,advisor): 跨包", "fix/a")?.kind, "code");
});

test("路径白名单：三档各自允许什么", () => {
  const release = { kind: "release", tier: "A" };
  assert.equal(fileAllowed(release, "packages/next-step/CHANGELOG.md", ""), true);
  assert.equal(fileAllowed(release, "packages/next-step/package.json", ""), true);
  assert.equal(fileAllowed(release, "pnpm-lock.yaml", ""), true);
  assert.equal(fileAllowed(release, ".changeset/x.md", ""), true);
  assert.equal(fileAllowed(release, "packages/next-step/lib/client.js", ""), false);

  const docs = { kind: "docs", tier: "B · 文档" };
  assert.equal(fileAllowed(docs, "docs/runtime/0.2.2-rc.3.md", ""), true);
  assert.equal(fileAllowed(docs, "README.md", ""), true);
  assert.equal(fileAllowed(docs, "packages/next-step/README.zh-CN.md", ""), true);
  assert.equal(fileAllowed(docs, ".changeset/y.md", ""), true);
  assert.equal(fileAllowed(docs, "packages/next-step/lib/client.js", ""), false);

  const code = { kind: "code", tier: "B · 单插件" };
  assert.equal(fileAllowed(code, "packages/next-step/lib/client.js", "next-step"), true);
  assert.equal(fileAllowed(code, ".changeset/z.md", "next-step"), true);
  assert.equal(fileAllowed(code, "packages/advisor/lib/service.js", "next-step"), false);
  assert.equal(fileAllowed(code, "package.json", "next-step"), false);
});

test("文档 PR：只有 .md / docs/ / changeset 才合规", () => {
  assert.equal(evaluate(pull()).ok, true);
  const bad = evaluate(pull({ files: ["docs/a.md", "packages/next-step/lib/client.js"] }));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.offending, ["packages/next-step/lib/client.js"]);
});

test("release PR：夹带源码就拒绝", () => {
  const ok = evaluate(
    pull({
      title: "chore(release): version packages",
      headRef: "changeset-release/main",
      files: [
        "packages/next-step/CHANGELOG.md",
        "packages/next-step/package.json",
        "pnpm-lock.yaml",
      ],
    }),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.tier, "A");

  const bad = evaluate(
    pull({
      title: "chore(release): version packages",
      headRef: "changeset-release/main",
      files: ["packages/next-step/package.json", "packages/next-step/lib/client.js"],
    }),
  );
  assert.equal(bad.ok, false);
});

test("单插件 PR：越出包目录（根 package.json、脚本、.github）都算越界", () => {
  const ok = evaluate(
    pull({
      title: "fix(next-step): 登记时序",
      files: [
        "packages/next-step/lib/client.js",
        "packages/next-step/test/a.test.js",
        ".changeset/fix.md",
      ],
    }),
  );
  assert.equal(ok.ok, true);

  for (const file of [
    "package.json",
    "scripts/publish.mjs",
    ".github/workflows/ci.yml",
    "types/dsh.d.ts",
  ]) {
    const bad = evaluate(
      pull({ title: "fix(next-step): x", files: [`packages/next-step/lib/a.js`, file] }),
    );
    assert.equal(bad.ok, false, `${file} 应当越界`);
  }
});

test("硬黑名单：标题是 docs: 也不许碰 .github / scripts / types / docs/adr", () => {
  for (const file of [
    ".github/pull_request_template.md",
    ".github/workflows/ci.yml",
    "scripts/check-plugins.mjs",
    "types/dsh.d.ts",
    "docs/adr/0014-automerge-tiers.md",
  ]) {
    const verdict = evaluate(pull({ files: ["docs/testing/next-step.md", file] }));
    assert.equal(verdict.ok, false, `${file} 应被硬黑名单拦下`);
    assert.deepEqual(verdict.offending, [file]);
  }
});

test("release 档不受硬黑名单影响（版本清单就在 package.json / lockfile 里）", () => {
  const verdict = evaluate(
    pull({
      title: "chore(release): version packages",
      headRef: "changeset-release/main",
      files: [
        "packages/next-step/CHANGELOG.md",
        "packages/next-step/package.json",
        "pnpm-lock.yaml",
      ],
    }),
  );
  assert.equal(verdict.ok, true);
});

test("C 档：feat / 无 scope / 不认识的标题一律不合规", () => {
  for (const title of [
    "feat(next-step): 新功能",
    "chore(deps): 升级",
    "refactor(advisor): 整理",
    "随便写的标题",
  ]) {
    const verdict = evaluate(pull({ title }));
    assert.equal(verdict.ok, false, `${title} 不应被允许自动合并`);
  }
});

test("外部 PR、needs-dsh-verify、REQUEST_CHANGES 都是硬拒绝", () => {
  assert.equal(evaluate(pull({ headRepo: "someone/dsh-plugins-fork" })).ok, false);
  assert.equal(evaluate(pull({ labels: ["automerge", "needs-dsh-verify"] })).ok, false);
  assert.equal(evaluate(pull({ changesRequested: 1 })).ok, false);
});

// guard 反例冒烟 2026-11-15：本行只用于验证「标题 docs: + 路径落在 scripts/」会被 automerge-guard 拒绝；PR 关闭后不保留。
