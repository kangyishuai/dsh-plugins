// @ts-check
// 用临时目录跑一遍「脚手架 → 校验」，保证模板本身永远能通过 check。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkRepo } from "../check-plugins.mjs";
import { scaffold } from "../new-plugin.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-plugins-test-"));
mkdirSync(join(root, "packages"));
after(() => rmSync(root, { recursive: true, force: true }));

test("模板生成的插件能通过全部检查", () => {
  const dir = scaffold({ root, name: "hello-world", description: "Hello" });
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.name, "@kangyishuai/dsh-hello-world");
  assert.equal(pkg.repository.directory, "packages/hello-world");
  assert.match(readFileSync(join(dir, "locale/zh.json"), "utf8"), /"helloWorld"/);
  assert.doesNotMatch(readFileSync(join(dir, "lib/client.js"), "utf8"), /__NAME__/);
  assert.deepEqual(checkRepo(root), []);
});

test("拒绝非法名与 dsh- 前缀", () => {
  assert.throws(() => scaffold({ root, name: "Bad_Name" }), /kebab-case/);
  assert.throws(() => scaffold({ root, name: "dsh-foo" }), /dsh-/);
  assert.throws(() => scaffold({ root, name: "hello-world" }), /已存在/);
});

test("能发现 locale 不一致、宿主依赖和重复 cordis id", () => {
  const dir = scaffold({ root, name: "broken" });
  writeFileSync(join(dir, "locale/en.json"), JSON.stringify({ broken: { other: "x" } }));
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.peerDependencies = { "@deepseek-ai/dsh-core": "*" };
  delete pkg.publishConfig;
  writeFileSync(pkgPath, JSON.stringify(pkg));
  writeFileSync(
    join(dir, "cordis.patch.yml"),
    "- insert:\n    - id: hello-world\n      name: '@kangyishuai/dsh-broken'\n",
  );

  const messages = checkRepo(root)
    .filter((i) => i.level === "error")
    .map((i) => `${i.plugin}: ${i.message}`)
    .join("\n");
  assert.match(messages, /locale\/en\.json 缺少 broken\.title/);
  assert.match(messages, /locale\/zh\.json 缺少 broken\.other/);
  assert.match(messages, /@deepseek-ai\/dsh-core/);
  assert.match(messages, /publishConfig\.access/);
  assert.match(messages, /hello-world: cordis id「hello-world」与 broken 重复/);
});

test("pnpm new 会登记到 labeler 与 bug 报告下拉，缺失时 check 给出警告", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "dsh-plugins-register-"));
  try {
    mkdirSync(join(repoRoot, "packages"));
    mkdirSync(join(repoRoot, ".github", "ISSUE_TEMPLATE"), { recursive: true });
    writeFileSync(join(repoRoot, ".github", "labeler.yml"), '"area:ci":\n  - changed-files: []\n');
    writeFileSync(
      join(repoRoot, ".github", "ISSUE_TEMPLATE", "bug_report.yml"),
      "body:\n  - type: dropdown\n    attributes:\n      options:\n        - other\n",
    );
    scaffold({ root: repoRoot, name: "foo-bar" });
    const labeler = readFileSync(join(repoRoot, ".github", "labeler.yml"), "utf8");
    assert.match(
      labeler,
      /"plugin:foo-bar":\n {2}- changed-files:\n {6}- any-glob-to-any-file: "packages\/foo-bar\/\*\*"/,
    );
    const bug = readFileSync(join(repoRoot, ".github", "ISSUE_TEMPLATE", "bug_report.yml"), "utf8");
    assert.match(bug, / {8}- "@kangyishuai\/dsh-foo-bar"\n {8}- other/);
    assert.deepEqual(checkRepo(repoRoot), []);

    writeFileSync(join(repoRoot, ".github", "labeler.yml"), "");
    assert.match(
      checkRepo(repoRoot)
        .map((i) => i.message)
        .join("\n"),
      /labeler\.yml 缺少/,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
