// @ts-check
// B3 单测：记忆碎片 / 16k 去重 / goal 上限 / 预算默认值 / 暂停语义 / 完成通知 /
// 本地文件夹授权 / GitHub 连接检查 / 模板受管区块 / `@` 候选。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { registerProjectContext } from "../lib/attach.js";
import { DEFAULT_BUDGET, normalizeBudgetPatch } from "../lib/budget.js";
import {
  dedupeAgainstHostInstructions,
  INSTRUCTION_BUDGET,
  renderProjectContext,
  USAGE_CONVENTIONS,
} from "../lib/context.js";
import {
  applyFolderDecision,
  consumeOnceFolderGrant,
  folderAuthSummary,
  normalizeFolderDecision,
} from "../lib/folder-auth.js";
import {
  GH_LOGIN_HINT,
  GH_MISSING_HINT,
  githubCheckResult,
  parseGhAuthStatus,
  parseGhRepoList,
} from "../lib/github.js";
import {
  fragmentIndexLine,
  normalizeFragmentText,
  parseFragmentLine,
  parseMemoryBlocks,
  previewText,
  removeMemoryBlock,
  uniqueFragmentSlug,
} from "../lib/memory.js";
import {
  buildMentionItems,
  formatMentionToken,
  normalizeMentionQuery,
  parseMentionToken,
} from "../lib/mentions.js";
import {
  DEFAULT_NOTIFY_PREFS,
  diffAttention,
  filterAttention,
  normalizeNotifyPatch,
  summarize,
} from "../lib/notify.js";
import { MAX_GOAL_CHARS, ProjectStore } from "../lib/store.js";
import {
  MANAGED_BEGIN,
  MANAGED_END,
  mergeManagedBlock,
  renderManagedAgentsBlock,
} from "../lib/template.js";

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "dsh-projects-b3-"));
  const store = new ProjectStore({ root }).load();
  return { root, store };
}

describe("F37 记忆碎片", () => {
  it("slug 去重且对中文安全", () => {
    assert.equal(uniqueFragmentSlug("Cache Layer", []), "cache-layer");
    assert.equal(uniqueFragmentSlug("缓存层", []), "缓存层");
    assert.equal(uniqueFragmentSlug("Cache", ["cache"]), "cache-2");
    assert.equal(uniqueFragmentSlug("!!!", []), "fragment");
  });

  it("索引行可往返解析，摘要取正文首行", () => {
    const line = fragmentIndexLine({ title: "缓存", slug: "cache", text: "\n第一行摘要\n第二行" });
    assert.match(line, /^- \[缓存\]\(fragments\/cache\.md\) — 第一行摘要$/u);
    assert.deepEqual(parseFragmentLine(line), {
      slug: "cache",
      title: "缓存",
      summary: "第一行摘要",
    });
    assert.equal(parseFragmentLine("- 普通记忆条目"), null);
    assert.equal(parseFragmentLine("- [x](other/x.md)"), null);
  });

  it("块解析带稳定 id，删一条不影响其它条", () => {
    const text = "- 第一条\n<!-- 2026-01-01 -->\n\n- [缓存](fragments/cache.md) — 摘要\n\n- 第三条";
    const blocks = parseMemoryBlocks(text);
    assert.equal(blocks.length, 3);
    assert.match(blocks[0].at, /2026-01-01/u);
    assert.equal(blocks[1].fragment?.slug, "cache");
    // 同一个块两次解析得到同一个 id（不随插入漂移）
    assert.equal(parseMemoryBlocks(text)[2].id, blocks[2].id);
    const removed = removeMemoryBlock(text, blocks[0].id);
    assert.equal(removed.ok, true);
    assert.doesNotMatch(removed.text, /第一条/u);
    assert.match(removed.text, /缓存/u);
    assert.equal(removeMemoryBlock(text, "ffffffff").ok, false);
  });

  it("碎片正文拒绝超限而不是悄悄截断；预览说明剩余", () => {
    assert.deepEqual(normalizeFragmentText("  "), { ok: false, reason: "empty-fragment" });
    const big = normalizeFragmentText("x".repeat(9_000));
    assert.equal(big.ok, false);
    const preview = previewText("a".repeat(500), 100);
    assert.equal(preview.truncated, true);
    assert.equal(preview.chars, 500);
    assert.equal(preview.preview.length, 100);
  });
});

describe("F38/F40 上下文注入", () => {
  it("与宿主已注入的 AGENTS.md 去重，并说明省略了几段", () => {
    const host =
      "很长的宿主规则甲，长度足够用来判断重复（第一段）\n\n很长的宿主规则乙，长度足够用来判断重复（第二段）";
    const dedupe = dedupeAgainstHostInstructions(`${host}\n\n我们的独有规则：分支从 main 起`, host);
    assert.equal(dedupe.dropped, 2);
    assert.doesNotMatch(dedupe.text, /宿主规则甲/u);
    assert.match(dedupe.text, /独有规则/u);
    const text = renderProjectContext({
      project: { name: "alpha" },
      instructions: host,
      hostInstructions: host,
    });
    assert.match(text, /已省略 2 段与 AGENTS\.md 重复的规则/u);
    // 短句不当作重复（避免吃掉有用的一行）
    assert.equal(dedupeAgainstHostInstructions("短", "短").dropped, 0);
  });

  it("默认预算 16k 仍成立，且使用约定写明「不是 AGENTS.md」", () => {
    assert.equal(INSTRUCTION_BUDGET, 16_000);
    assert.match(USAGE_CONVENTIONS, /不是 AGENTS\.md 或 CLAUDE\.md/u);
    const text = renderProjectContext({ project: { name: "alpha" } });
    assert.ok(text.length <= INSTRUCTION_BUDGET);
  });
});

describe("F39 goal 上限 / F22 预算默认值", () => {
  it("goal 超过 8000 被写入口拒绝（create 与 update 都拒绝）", () => {
    const { root, store } = makeStore();
    try {
      assert.equal(MAX_GOAL_CHARS, 8_000);
      assert.throws(() => store.createProject("x", { goal: "g".repeat(8_001) }), /goal exceeds/u);
      const project = store.createProject("ok", { goal: "g".repeat(8_000) });
      assert.equal(project.goal.length, 8_000);
      assert.throws(
        () => store.updateProject(project.id, { goal: "g".repeat(8_001) }),
        /goal exceeds/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("新建项目带默认预算（日 20 / 并发 2 / 步数 60 / token 不限）", () => {
    const { root, store } = makeStore();
    try {
      assert.deepEqual(DEFAULT_BUDGET, {
        dailyTokens: null,
        // AUD-PROJ-04：周 token 预算以前不在默认值/字段表/归一化里（死闸门），现在纳入
        weeklyTokens: null,
        maxThreadsPerDay: 20,
        maxConcurrent: 2,
        maxStepsPerThread: 60,
      });
      const project = store.createProject("budget");
      assert.deepEqual(project.budget, { ...DEFAULT_BUDGET });
      // 写→回读闭环：磁盘上也是默认值
      store.save();
      const reloaded = new ProjectStore({ root }).load().getProject(project.id);
      assert.deepEqual(reloaded?.budget, { ...DEFAULT_BUDGET });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("预算补丁规范化：null=不限、负数/非法拒绝", () => {
    assert.deepEqual(normalizeBudgetPatch({ maxConcurrent: "3" }), {
      ok: true,
      budget: { maxConcurrent: 3 },
    });
    assert.deepEqual(normalizeBudgetPatch({ maxThreadsPerDay: null }), {
      ok: true,
      budget: { maxThreadsPerDay: null },
    });
    assert.equal(normalizeBudgetPatch({ maxConcurrent: -1 }).ok, false);
    assert.equal(normalizeBudgetPatch({}).ok, false);
    assert.equal(normalizeBudgetPatch({ nope: 1 }).ok, false);
  });
});

describe("F44 暂停不停上下文注入", () => {
  it("paused 项目仍然注入；archived 才停", () => {
    const { root, store } = makeStore();
    try {
      const project = store.createProject("paused", { goal: "g" });
      store.attachThread("session-paused", project.id);
      store.updateProject(project.id, { state: "paused" });
      /** @type {any} */
      let entry = null;
      registerProjectContext({
        getStore: () => store,
        getDataRoot: () => root,
        register: (definition) => {
          entry = definition;
          return () => {};
        },
      });
      const pausedText = entry.text({ agent: { session: { id: "session-paused" } } });
      assert.match(pausedText, /当前项目：paused/u);
      store.updateProject(project.id, { state: "archived" });
      const archivedText = entry.text({ agent: { session: { id: "session-paused" } } });
      assert.equal(archivedText, "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("F58 完成通知 + 按项目开关", () => {
  it("working → idle 触发完成通知，只在新线程之外", () => {
    const items = diffAttention(
      { threads: { a: { state: "working", projectId: "p1" } }, projects: ["p1"] },
      { threads: { a: { state: "idle", projectId: "p1" } }, projects: ["p1"] },
    );
    assert.deepEqual(items, [{ kind: "completed", projectId: "p1", sessionId: "a" }]);
    // 刚出现的新线程（之前没有记录）不算「完成」
    assert.deepEqual(
      diffAttention(
        { threads: {}, projects: ["p1"] },
        { threads: { b: { state: "idle", projectId: "p1" } }, projects: ["p1"] },
      ),
      [],
    );
  });

  it("完成默认关；项目可单独打开；非法补丁被拒", () => {
    assert.equal(DEFAULT_NOTIFY_PREFS.completed, false);
    const items = [
      { kind: "completed", projectId: "p1" },
      { kind: "failed", projectId: "p1" },
    ];
    assert.deepEqual(filterAttention(items), [{ kind: "failed", projectId: "p1" }]);
    assert.deepEqual(filterAttention(items, { p1: { completed: true } }).length, 2);
    assert.deepEqual(normalizeNotifyPatch({ completed: true }), {
      ok: true,
      prefs: { completed: true },
    });
    assert.equal(normalizeNotifyPatch({ failed: "yes" }).ok, false);
    assert.equal(normalizeNotifyPatch({}).ok, false);
    assert.equal(summarize([{ kind: "completed" }]).text, "1 个线程完成了");
  });
});

describe("F55/U20 本地文件夹授权三键", () => {
  it("三键写入可回读；once 用掉即失效；非法决策被拒", () => {
    assert.equal(normalizeFolderDecision("switch"), "");
    assert.equal(normalizeFolderDecision("default"), "default");
    const denied = applyFolderDecision({}, "/repo", "deny", Date.parse("2026-01-01T00:00:00Z"));
    assert.equal(denied.ok, true);
    if (denied.ok) assert.equal(folderAuthSummary(denied.policy, "/repo").allowed, false);
    const allowed = applyFolderDecision({}, "/repo", "default");
    if (allowed.ok) {
      assert.equal(folderAuthSummary(allowed.policy, "/repo").mode, "default");
      assert.equal(folderAuthSummary(allowed.policy, "/repo").allowed, true);
      // default 不是一次性的：summary 一直是 allowed
      assert.equal(folderAuthSummary(allowed.policy, "/repo").allowed, true);
    }
    const once = applyFolderDecision({}, "/once", "once");
    assert.equal(once.ok, true);
    if (once.ok) {
      assert.equal(folderAuthSummary(once.policy, "/once").allowed, true);
      const consumed = consumeOnceFolderGrant(once.policy, "/once");
      assert.equal(consumed.ok, true);
      assert.equal(folderAuthSummary(consumed.policy, "/once").allowed, false);
      // 再消费一次失败（避免一张凭据用两次）
      assert.equal(consumeOnceFolderGrant(consumed.policy, "/once").ok, false);
    }
    assert.equal(applyFolderDecision({}, "", "default").ok, false);
  });
});

describe("F4 GitHub 连接检查", () => {
  it("未安装 / 未登录 / 缺 scope / 正常 四种结论都可操作", () => {
    const missing = parseGhAuthStatus({ stdout: "", stderr: "spawn gh ENOENT", code: 127 });
    assert.equal(missing.installed, false);
    assert.equal(missing.hint, GH_MISSING_HINT);
    assert.equal(githubCheckResult(missing).level, "error");
    const notLogged = parseGhAuthStatus({
      stdout: "",
      stderr: "You are not logged into any GitHub hosts",
      code: 1,
    });
    assert.equal(notLogged.authenticated, false);
    assert.equal(notLogged.hint, GH_LOGIN_HINT);
    const okStatus = parseGhAuthStatus({
      stdout: [
        "github.com",
        "  ✓ Logged in to github.com account octocat (keyring)",
        "  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
      ].join("\n"),
      code: 0,
    });
    assert.equal(okStatus.authenticated, true);
    assert.equal(okStatus.account, "octocat");
    assert.equal(okStatus.missingRepoScope, false);
    const repos = parseGhRepoList({ stdout: "octo/a\tdesc\nacme/b\tother\n", code: 0 });
    assert.deepEqual(repos.repos, ["octo/a", "acme/b"]);
    const result = githubCheckResult(okStatus, repos);
    assert.equal(result.level, "ok");
    assert.equal(result.repoCount, 2);
    assert.match(result.message, /octocat/u);
    const narrow = parseGhAuthStatus({
      stdout: "Logged in to github.com account octocat\n  - Token scopes: 'gist'",
      code: 0,
    });
    assert.equal(narrow.missingRepoScope, true);
    assert.equal(githubCheckResult(narrow).actions[0], "gh auth refresh -s repo,read:org");
  });
});

describe("F5 模板受管区块", () => {
  it("受管区块幂等合并，绝不覆盖区块外内容", () => {
    const block = renderManagedAgentsBlock({ name: "payments", budget: { maxThreadsPerDay: 20 } });
    assert.match(block, /^<!-- dsh-projects:begin/u);
    assert.match(block, /日线程 20 · 并发 不限/u);
    assert.match(block, /线程分支前缀：`feat\/`/u);
    const created = mergeManagedBlock("", block);
    assert.equal(created.created, true);
    assert.match(created.text, new RegExp(MANAGED_BEGIN.slice(0, 20), "u"));
    const user = `# 用户的规则\n\n别覆盖我\n\n${block}\n`;
    const merged = mergeManagedBlock(user, block);
    assert.equal(merged.replaced, true);
    assert.match(merged.text, /别覆盖我/u);
    // 再合一次结果不变（幂等）
    assert.equal(mergeManagedBlock(merged.text, block).text, merged.text);
    const appended = mergeManagedBlock("# 用户规则\n", block);
    assert.equal(appended.replaced, false);
    assert.match(appended.text, /# 用户规则/u);
    assert.match(appended.text, new RegExp(MANAGED_END.slice(0, 20), "u"));
  });
});

describe("F62 @ 提及候选", () => {
  it("空查询先项目后线程；查询过滤项目名/线程标题；上限生效", () => {
    const projects = [
      { id: "p1", name: "payments", updatedAt: "2026-01-02T00:00:00Z" },
      { id: "p2", name: "billing", updatedAt: "2026-01-01T00:00:00Z" },
    ];
    const threads = [
      { sessionId: "s1", projectId: "p1", title: "修 CI", lastActivityAt: "2026-01-03T00:00:00Z" },
      {
        sessionId: "s2",
        projectId: "p2",
        title: "账单重构",
        lastActivityAt: "2026-01-02T00:00:00Z",
      },
    ];
    const all = buildMentionItems({ projects, threads });
    assert.deepEqual(
      all.map((item) => item.kind),
      ["project", "project", "thread", "thread"],
    );
    const filtered = buildMentionItems({ projects, threads, query: "@ci" });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "s1");
    assert.equal(normalizeMentionQuery("@  CI "), "ci");
    assert.equal(buildMentionItems({ projects, threads, limit: 1 }).length, 1);
    assert.equal(buildMentionItems({ projects, threads, query: "zzz" }).length, 0);
    // 插入 token 的格式（client 的 inputTriggers source 用同一份规则）
    assert.equal(formatMentionToken("thread", "s1"), "@thread:s1");
    assert.equal(formatMentionToken("project", "p1"), "@project:p1");
    assert.equal(formatMentionToken("thread", "  "), "");
    assert.equal(formatMentionToken("other", "x"), "");
    assert.deepEqual(parseMentionToken("@thread:s1"), { kind: "thread", id: "s1" });
    assert.deepEqual(parseMentionToken("@project:p1"), { kind: "project", id: "p1" });
    assert.equal(parseMentionToken("@file:x"), null);
    assert.equal(parseMentionToken("plain"), null);
  });
});

describe("F23 线程标题与 F58 偏好落盘", () => {
  let root = "";
  /** @type {ProjectStore} */
  let store;
  /** @type {any} */
  let project;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dsh-projects-b3b-"));
    store = new ProjectStore({ root }).load();
    project = store.createProject("renames");
    store.attachThread("session-x", project.id);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("重命名写回并落盘；清空回到投影标题", () => {
    assert.equal(store.setThreadTitle("session-x", "  我的线程  ").title, "我的线程");
    store.save();
    const reloaded = new ProjectStore({ root }).load();
    assert.equal(reloaded.state.threads["session-x"].title, "我的线程");
    assert.equal(store.setThreadTitle("session-x", "").title, "");
    assert.throws(() => store.setThreadTitle("missing", "x"), /unknown thread/u);
  });

  it("通知偏好只认布尔键并落盘", () => {
    const result = store.setNotifyPrefs(project.id, { completed: true, failed: false });
    assert.equal(result.prefs.completed, true);
    assert.equal(result.prefs.failed, false);
    assert.equal(result.prefs["waiting-user"], true);
    store.save();
    const reloaded = new ProjectStore({ root }).load().getProject(project.id);
    assert.equal(reloaded?.notifyPrefs.completed, true);
    assert.equal(store.setNotifyPrefs(project.id, { failed: "no" }).prefs.failed, false);
  });
});

// F3「记忆目录读取」的真实覆盖在 memory-store.test.js：`listFragments` / `readFragment` /
// `listFragmentFiles` 都是生产代码，测试用 mkdtemp 真读盘。这里原来的实现只 filter 了一个
// 字面量数组（不调用任何生产代码，恒真），删除以免误读为已覆盖。
