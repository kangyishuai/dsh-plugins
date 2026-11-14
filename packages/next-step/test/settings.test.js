// @ts-check
// settings.js 纯函数与文件读写单测：
// 默认值 / 未知键丢弃 / 类型回落 / 数字夹紧 / 暂停时间 / mkdtemp 临时目录读写（绝不碰 ~/.dsh）。
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import {
  DEFAULT_SETTINGS,
  LEGACY_MAX_CARDS,
  loadSettings,
  loadSettingsWithMeta,
  migrateSettings,
  normalizeSettings,
  SETTINGS_FILE,
  SETTINGS_SCHEMA_VERSION,
  saveSettings,
  settingsPath,
} from "../lib/settings.js";

/** @type {string[]} */
const tempDirs = [];

/** 建一个临时数据根；测试结束统一清理。 @param {string} [label] */
async function makeHome(label = "next-step-settings-") {
  const dir = await mkdtemp(join(tmpdir(), label));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** 记录 warn 的假 logger。 */
function fakeLogger() {
  /** @type {string[]} */
  const warnings = [];
  return {
    warnings,
    logger: {
      warn: (/** @type {string} */ message) => warnings.push(String(message)),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. 默认值
// ---------------------------------------------------------------------------

test("SETTINGS_FILE 是数据根下的固定文件名", () => {
  assert.equal(
    SETTINGS_FILE,
    "next-step.settings.json",
    `期望 SETTINGS_FILE="next-step.settings.json"，实际=${JSON.stringify(SETTINGS_FILE)}`,
  );
});

test("settingsPath(home) 拼在数据根下（不写死 ~/.dsh）", () => {
  const actual = settingsPath("/tmp/some-home");
  const expected = join("/tmp/some-home", "next-step.settings.json");
  assert.equal(actual, expected, `期望=${expected} 实际=${actual}`);
});

test("normalizeSettings({}) 返回默认值", () => {
  assert.deepEqual(
    normalizeSettings({}),
    { ...DEFAULT_SETTINGS },
    `期望=默认值 ${JSON.stringify(DEFAULT_SETTINGS)} 实际=${JSON.stringify(normalizeSettings({}))}`,
  );
});

test("默认值本身：卡片开、幽灵关、预算 30 张", () => {
  assert.equal(DEFAULT_SETTINGS.enabled, true, "期望 enabled=true");
  assert.equal(DEFAULT_SETTINGS.card, true, "期望 card=true");
  assert.equal(DEFAULT_SETTINGS.ghost, false, "期望 ghost=false（幽灵提示默认关）");
  assert.equal(
    DEFAULT_SETTINGS.maxCardsPerSession,
    120,
    "期望 maxCardsPerSession=120（v0.4 放宽）",
  );
  assert.equal(DEFAULT_SETTINGS.pauseUntil, 0, "期望 pauseUntil=0（未暂停）");
});

test("非法输入（null / 数组 / 字符串）都回落默认值，不抛错", () => {
  for (const raw of [null, undefined, [], "not-an-object", 42]) {
    const actual = normalizeSettings(raw);
    assert.deepEqual(
      actual,
      { ...DEFAULT_SETTINGS },
      `raw=${JSON.stringify(raw)} 期望=默认值 实际=${JSON.stringify(actual)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. 未知字段忽略 + 类型回落
// ---------------------------------------------------------------------------

test("未知字段被丢弃（不落进返回对象）", () => {
  const actual = normalizeSettings({
    enabled: false,
    ghost: true,
    nope: "x",
    nesting: { a: 1 },
    __proto__: { polluted: true },
  });
  assert.deepEqual(
    Object.keys(actual).sort(),
    Object.keys(DEFAULT_SETTINGS).sort(),
    `期望键集合=${Object.keys(DEFAULT_SETTINGS).sort().join(",")} 实际=${Object.keys(actual).sort().join(",")}`,
  );
  assert.equal(actual.enabled, false, "期望 enabled 被采纳为 false");
  assert.equal(actual.ghost, true, "期望 ghost 被采纳为 true");
  assert.equal("nope" in actual, false, "期望未知键 nope 不存在");
});

test("布尔字段类型不符时回落默认，不是强转", () => {
  const actual = normalizeSettings({ enabled: "false", card: 0, ghost: 1 });
  assert.equal(
    actual.enabled,
    DEFAULT_SETTINGS.enabled,
    `enabled="false" 期望回落 ${DEFAULT_SETTINGS.enabled}，实际=${actual.enabled}（不要强转成 false）`,
  );
  assert.equal(
    actual.card,
    DEFAULT_SETTINGS.card,
    `card=0 期望回落 ${DEFAULT_SETTINGS.card}，实际=${actual.card}`,
  );
  assert.equal(
    actual.ghost,
    DEFAULT_SETTINGS.ghost,
    `ghost=1 期望回落 ${DEFAULT_SETTINGS.ghost}，实际=${actual.ghost}`,
  );
});

test("数字字段类型不符时回落默认", () => {
  const actual = normalizeSettings({ maxTokens: "abc", timeoutMs: {}, contextMessages: NaN });
  assert.equal(
    actual.maxTokens,
    DEFAULT_SETTINGS.maxTokens,
    `maxTokens="abc" 实际=${actual.maxTokens}`,
  );
  assert.equal(
    actual.timeoutMs,
    DEFAULT_SETTINGS.timeoutMs,
    `timeoutMs={} 实际=${actual.timeoutMs}`,
  );
  assert.equal(
    actual.contextMessages,
    DEFAULT_SETTINGS.contextMessages,
    `contextMessages=NaN 实际=${actual.contextMessages}`,
  );
});

test("provider / model 去空白；非法类型回落空串", () => {
  const trimmed = normalizeSettings({ provider: "  deepseek  ", model: " deepseek-chat " });
  assert.equal(
    trimmed.provider,
    "deepseek",
    `期望="deepseek" 实际=${JSON.stringify(trimmed.provider)}`,
  );
  assert.equal(
    trimmed.model,
    "deepseek-chat",
    `期望="deepseek-chat" 实际=${JSON.stringify(trimmed.model)}`,
  );
  const bad = normalizeSettings({ provider: 123, model: null });
  assert.equal(bad.provider, "", `provider=123 期望="" 实际=${JSON.stringify(bad.provider)}`);
  assert.equal(bad.model, "", `model=null 期望="" 实际=${JSON.stringify(bad.model)}`);
});

test("字符串字段超长截断到 200（防配置里塞整段 prompt）", () => {
  const long = "x".repeat(500);
  const actual = normalizeSettings({ provider: long });
  assert.equal(actual.provider.length, 200, `期望长度=200 实际=${actual.provider.length}`);
});

// ---------------------------------------------------------------------------
// 3. 暂停时间
// ---------------------------------------------------------------------------

test("pauseUntil 保留合法 epoch 毫秒", () => {
  const until = 1_800_000_000_000;
  const actual = normalizeSettings({ pauseUntil: until });
  assert.equal(actual.pauseUntil, until, `期望=${until} 实际=${actual.pauseUntil}`);
});

test("pauseUntil 负数夹到 0（不能暂停到过去）", () => {
  const actual = normalizeSettings({ pauseUntil: -5 });
  assert.equal(actual.pauseUntil, 0, `pauseUntil=-5 期望=0 实际=${actual.pauseUntil}`);
});

test("pauseUntil 小数取整、超大值夹到 MAX_SAFE_INTEGER", () => {
  assert.equal(
    normalizeSettings({ pauseUntil: 1000.6 }).pauseUntil,
    1001,
    `pauseUntil=1000.6 期望取整为 1001，实际=${normalizeSettings({ pauseUntil: 1000.6 }).pauseUntil}`,
  );
  const huge = normalizeSettings({ pauseUntil: Number.MAX_VALUE }).pauseUntil;
  assert.equal(
    huge,
    Number.MAX_SAFE_INTEGER,
    `pauseUntil=Number.MAX_VALUE 期望=${Number.MAX_SAFE_INTEGER} 实际=${huge}`,
  );
});

test("pauseUntil 数字字符串按数字处理", () => {
  const actual = normalizeSettings({ pauseUntil: "1800000000000" });
  assert.equal(
    actual.pauseUntil,
    1_800_000_000_000,
    `pauseUntil="1800000000000" 期望=1800000000000 实际=${actual.pauseUntil}`,
  );
});

// ---------------------------------------------------------------------------
// 4. 预算夹紧（0 / 负数 / 超大）
// ---------------------------------------------------------------------------

test("maxCardsPerSession 夹在 0–1000", () => {
  /** @type {[unknown, number, string][]} */
  const cases = [
    [0, 0, "0（关闭每会话卡片数上限）应保持 0"],
    [-1, 0, "-1 应夹到 0"],
    [-99999, 0, "超大负数应夹到 0"],
    [7, 7, "区间内原样保留"],
    [1000, 1000, "上界 1000 保留"],
    [1001, 1000, "1001 应夹到 1000"],
    [1e9, 1000, "1e9 应夹到 1000"],
    [3.4, 3, "3.4 应取整为 3"],
    [3.6, 4, "3.6 应取整为 4"],
  ];
  for (const [input, expected, why] of cases) {
    const actual = normalizeSettings({ maxCardsPerSession: input }).maxCardsPerSession;
    assert.equal(
      actual,
      expected,
      `maxCardsPerSession=${input}：${why}，期望=${expected} 实际=${actual}`,
    );
  }
});

test("maxTokens 夹在 128–4000", () => {
  /** @type {[unknown, number][]} */
  const cases = [
    [0, 128],
    [-10, 128],
    [127, 128],
    [128, 128],
    [500, 500],
    [4000, 4000],
    [4001, 4000],
    [1e9, 4000],
  ];
  for (const [input, expected] of cases) {
    const actual = normalizeSettings({ maxTokens: input }).maxTokens;
    assert.equal(actual, expected, `maxTokens=${input} 期望=${expected} 实际=${actual}`);
  }
});

test("timeoutMs 夹在 3000–120000", () => {
  /** @type {[unknown, number][]} */
  const cases = [
    [0, 3000],
    [-1, 3000],
    [2999, 3000],
    [3000, 3000],
    [20000, 20000],
    [120000, 120000],
    [120001, 120000],
  ];
  for (const [input, expected] of cases) {
    const actual = normalizeSettings({ timeoutMs: input }).timeoutMs;
    assert.equal(actual, expected, `timeoutMs=${input} 期望=${expected} 实际=${actual}`);
  }
});

test("contextMessages 夹在 4–40", () => {
  /** @type {[unknown, number][]} */
  const cases = [
    [0, 4],
    [-3, 4],
    [3, 4],
    [4, 4],
    [12, 12],
    [40, 40],
    [41, 40],
    [1000, 40],
  ];
  for (const [input, expected] of cases) {
    const actual = normalizeSettings({ contextMessages: input }).contextMessages;
    assert.equal(actual, expected, `contextMessages=${input} 期望=${expected} 实际=${actual}`);
  }
});

test("全部字段一起给非法值：每一项都独立夹紧/回落", () => {
  const actual = normalizeSettings({
    enabled: true,
    card: false,
    ghost: true,
    maxCardsPerSession: -5,
    pauseUntil: -1,
    timeoutMs: 1,
    maxTokens: 999999,
    provider: "",
    model: "",
    contextMessages: 999,
    junk: true,
  });
  assert.equal(actual.maxCardsPerSession, 0, `实际=${actual.maxCardsPerSession}`);
  assert.equal(actual.pauseUntil, 0, `实际=${actual.pauseUntil}`);
  assert.equal(actual.timeoutMs, 3000, `实际=${actual.timeoutMs}`);
  assert.equal(actual.maxTokens, 4000, `实际=${actual.maxTokens}`);
  assert.equal(actual.contextMessages, 40, `实际=${actual.contextMessages}`);
  assert.equal("junk" in actual, false, "未知键 junk 应被丢弃");
});

// ---------------------------------------------------------------------------
// 5. 文件读写（mkdtemp 临时目录，绝不碰 ~/.dsh）
// ---------------------------------------------------------------------------

test("loadSettings：文件不存在 → 默认值，且不记 warn（ENOENT 属正常）", async () => {
  const home = await makeHome();
  const { warnings, logger } = fakeLogger();
  const actual = await loadSettings({ home, logger });
  assert.deepEqual(
    actual,
    { ...DEFAULT_SETTINGS },
    `期望=${JSON.stringify(DEFAULT_SETTINGS)} 实际=${JSON.stringify(actual)}`,
  );
  assert.deepEqual(warnings, [], `期望无告警，实际=${JSON.stringify(warnings)}`);
});

test("saveSettings → loadSettings 往返一致，且文件落在 settingsPath(home)", async () => {
  const home = await makeHome();
  const saved = await saveSettings({
    home,
    patch: { enabled: false, ghost: true, maxCardsPerSession: 5, model: "m-1" },
  });
  assert.equal(saved.enabled, false, `返回值 enabled 期望=false 实际=${saved.enabled}`);
  assert.equal(saved.ghost, true, `返回值 ghost 期望=true 实际=${saved.ghost}`);
  assert.equal(
    saved.maxCardsPerSession,
    5,
    `返回值 maxCardsPerSession 期望=5 实际=${saved.maxCardsPerSession}`,
  );

  const file = settingsPath(home);
  const text = await readFile(file, "utf8");
  const onDisk = JSON.parse(text);
  assert.equal(onDisk.enabled, false, `磁盘 enabled 期望=false 实际=${onDisk.enabled}`);
  assert.equal(onDisk.ghost, true, `磁盘 ghost 期望=true 实际=${onDisk.ghost}`);

  const loaded = await loadSettings({ home });
  assert.deepEqual(
    loaded,
    saved,
    `往返后期望=${JSON.stringify(saved)} 实际=${JSON.stringify(loaded)}`,
  );
});

test("saveSettings 是合并写入：patch 只改给出的键，其余保持已存值", async () => {
  const home = await makeHome();
  await saveSettings({ home, patch: { maxTokens: 900, provider: "p1", model: "m1" } });
  const merged = await saveSettings({ home, patch: { enabled: false } });
  assert.equal(merged.enabled, false, `enabled 期望=false 实际=${merged.enabled}`);
  assert.equal(merged.maxTokens, 900, `未提到的 maxTokens 期望保持 900 实际=${merged.maxTokens}`);
  assert.equal(merged.provider, "p1", `未提到的 provider 期望保持 p1 实际=${merged.provider}`);
  assert.equal(merged.model, "m1", `未提到的 model 期望保持 m1 实际=${merged.model}`);
});

test("saveSettings 对 patch 里的非法值同样夹紧/丢弃未知键，且不污染磁盘", async () => {
  const home = await makeHome();
  const saved = await saveSettings({
    home,
    patch: { maxCardsPerSession: 99999, timeoutMs: -1, unknownField: "x" },
  });
  assert.equal(saved.maxCardsPerSession, 1000, `期望夹到 1000 实际=${saved.maxCardsPerSession}`);
  assert.equal(saved.timeoutMs, 3000, `期望夹到 3000 实际=${saved.timeoutMs}`);
  assert.equal("unknownField" in saved, false, "未知键应被丢弃");
  const onDisk = JSON.parse(await readFile(settingsPath(home), "utf8"));
  assert.equal("unknownField" in onDisk, false, "未知键不应写进磁盘");
});

test("loadSettings：损坏的 JSON → 默认值 + warn（绝不抛错）", async () => {
  const home = await makeHome();
  await writeFile(settingsPath(home), "{ not json", "utf8");
  const { warnings, logger } = fakeLogger();
  const actual = await loadSettings({ home, logger });
  assert.deepEqual(actual, { ...DEFAULT_SETTINGS }, `期望=默认值 实际=${JSON.stringify(actual)}`);
  assert.equal(
    warnings.length,
    1,
    `期望 1 条 warn，实际=${warnings.length}：${JSON.stringify(warnings)}`,
  );
  assert.match(
    warnings[0] ?? "",
    /next-step: cannot read/u,
    `warn 文案期望含 "next-step: cannot read"，实际=${JSON.stringify(warnings[0])}`,
  );
});

test("loadSettings：磁盘上未知键被丢弃、越界值被夹紧", async () => {
  const home = await makeHome();
  await writeFile(
    settingsPath(home),
    JSON.stringify({ enabled: false, extra: 1, maxTokens: 5, pauseUntil: -1 }),
    "utf8",
  );
  const actual = await loadSettings({ home });
  assert.equal(actual.enabled, false, `enabled 期望=false 实际=${actual.enabled}`);
  assert.equal(actual.maxTokens, 128, `maxTokens=5 期望夹到 128 实际=${actual.maxTokens}`);
  assert.equal(actual.pauseUntil, 0, `pauseUntil=-1 期望夹到 0 实际=${actual.pauseUntil}`);
  assert.equal("extra" in actual, false, "磁盘上的未知键应被丢弃");
});

test("saveSettings 会创建数据根（不要求调用方先 mkdir）", async () => {
  const home = await makeHome();
  const nested = join(home, "does", "not", "exist");
  await saveSettings({ home: nested, patch: { enabled: false } });
  const loaded = await loadSettings({ home: nested });
  assert.equal(
    loaded.enabled,
    false,
    `嵌套数据根写入后应能读回 enabled=false，实际=${loaded.enabled}`,
  );
});

test("saveSettings 用 tmp + rename 原子写：临时文件不残留", async () => {
  const home = await makeHome();
  await saveSettings({ home, patch: { enabled: false } });
  const names = await readdir(home);
  const leftovers = names.filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], `期望没有 .tmp 残留，实际目录内容=${JSON.stringify(names)}`);
  assert.deepEqual(
    names.sort(),
    [SETTINGS_FILE],
    `期望目录里只有 ${SETTINGS_FILE}，实际=${JSON.stringify(names)}`,
  );
});

test("所有读写都发生在传入的临时 home 内（没有写到 ~/.dsh 或仓库）", async () => {
  const home = await makeHome();
  await saveSettings({ home, patch: { enabled: false } });
  const file = settingsPath(home);
  const rel = relative(home, file);
  assert.equal(
    rel,
    SETTINGS_FILE,
    `期望设置在临时 home 内（相对路径=${SETTINGS_FILE}），实际相对路径=${rel}`,
  );
  assert.equal(file.startsWith(home), true, `期望设置路径以临时 home 开头，实际=${file}`);
  assert.equal(
    file.includes(`${join("", ".dsh")}`) && !home.includes(".dsh"),
    false,
    `期望不出现真实 ~/.dsh 路径，实际=${file}`,
  );
});

test("并发写不会交错出半个 JSON（rename 原子性）", async () => {
  const home = await makeHome();
  await Promise.all([
    saveSettings({ home, patch: { maxTokens: 200 } }),
    saveSettings({ home, patch: { maxTokens: 300 } }),
    saveSettings({ home, patch: { maxTokens: 400 } }),
  ]);
  const onDisk = JSON.parse(await readFile(settingsPath(home), "utf8"));
  assert.ok(
    [200, 300, 400].includes(onDisk.maxTokens),
    `并发写后磁盘 maxTokens 期望是 200/300/400 之一，实际=${onDisk.maxTokens}`,
  );
  const names = await readdir(home);
  assert.deepEqual(
    names.filter((name) => name.endsWith(".tmp")),
    [],
    `并发写后不应残留 .tmp 文件，实际=${JSON.stringify(names)}`,
  );
});

// ---------------------------------------------------------------------------
// v0.4：档位 / 采集开关 / v1 → v2 迁移
// ---------------------------------------------------------------------------

test("v2 默认值：档位平衡、采集开、schemaVersion=2、预算 120", () => {
  const settings = normalizeSettings({});
  assert.equal(settings.cardThreshold, "could", "默认档位应为平衡（could）");
  assert.equal(settings.telemetry, true, "采集默认开");
  assert.equal(settings.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(settings.maxCardsPerSession, 120);
});

test("cardThreshold 只接受三个枚举值，非法值回落默认档位", () => {
  for (const good of ["must", "could", "any"]) {
    assert.equal(normalizeSettings({ cardThreshold: good }).cardThreshold, good);
  }
  for (const bad of ["", "balanced", "MUST", 1, null, true]) {
    assert.equal(
      normalizeSettings({ cardThreshold: bad }).cardThreshold,
      "could",
      `cardThreshold=${JSON.stringify(bad)} 期望回落 could`,
    );
  }
});

test("telemetry 只接受布尔值（字符串 true 不算开）", () => {
  assert.equal(normalizeSettings({ telemetry: false }).telemetry, false);
  assert.equal(normalizeSettings({ telemetry: true }).telemetry, true);
  assert.equal(
    normalizeSettings({ telemetry: "false" }).telemetry,
    true,
    "字符串不是布尔，回落默认",
  );
  assert.equal(normalizeSettings({ telemetry: 0 }).telemetry, true);
});

test("migrateSettings：v1 文件（无 schemaVersion）里的旧默认 30 → 120", () => {
  const { settings, migrated } = migrateSettings({
    enabled: true,
    card: true,
    ghost: false,
    maxCardsPerSession: LEGACY_MAX_CARDS,
  });
  assert.equal(migrated, true, "缺 schemaVersion 应标记为需要写回");
  assert.equal(settings.maxCardsPerSession, 120, "旧默认值应被抬到 120");
  assert.equal(settings.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(settings.cardThreshold, "could", "新字段补默认值");
});

test("migrateSettings：v1 文件里用户自己设的其它数字不动", () => {
  const { settings } = migrateSettings({ maxCardsPerSession: 7, timeoutMs: 15000 });
  assert.equal(settings.maxCardsPerSession, 7, "非旧默认值不应被改");
  assert.equal(settings.timeoutMs, 15000);
});

test("migrateSettings：显式 schemaVersion=2 的文件里 30 就是用户的选择，不抬", () => {
  const { settings, migrated } = migrateSettings({
    schemaVersion: 2,
    maxCardsPerSession: LEGACY_MAX_CARDS,
  });
  assert.equal(migrated, false, "已是 v2，不需要写回");
  assert.equal(settings.maxCardsPerSession, 30, "v2 文件里的 30 必须保留");
});

test("migrateSettings：非法输入不抛错，返回默认值", () => {
  for (const raw of [null, undefined, 42, "text", []]) {
    const { settings } = migrateSettings(raw);
    assert.equal(settings.cardThreshold, "could");
    assert.equal(settings.maxCardsPerSession, 120);
  }
});

test("loadSettingsWithMeta：磁盘上是 v1 文件时标记 migrated，且读取值已迁移", async () => {
  const home = await mkdtemp(join(tmpdir(), "ns-settings-meta-"));
  tempDirs.push(home);
  await writeFile(
    join(home, SETTINGS_FILE),
    `${JSON.stringify({ enabled: true, card: true, maxCardsPerSession: LEGACY_MAX_CARDS })}\n`,
    "utf8",
  );
  const meta = await loadSettingsWithMeta({ home });
  assert.equal(meta.migrated, true);
  assert.equal(meta.exists, true);
  assert.equal(meta.settings.maxCardsPerSession, 120);
  assert.equal(meta.settings.cardThreshold, "could");
});

test("loadSettingsWithMeta：文件不存在时不标记迁移（不凭空造文件）", async () => {
  const home = await mkdtemp(join(tmpdir(), "ns-settings-meta2-"));
  tempDirs.push(home);
  const meta = await loadSettingsWithMeta({ home });
  assert.equal(meta.migrated, false);
  assert.equal(meta.exists, false);
  assert.deepEqual(meta.settings, { ...DEFAULT_SETTINGS });
  const files = await readdir(home);
  assert.deepEqual(files, [], "读取不应创建任何文件");
});

test("saveSettings 写出的文件带 schemaVersion=2（下一次读取不再迁移）", async () => {
  const home = await mkdtemp(join(tmpdir(), "ns-settings-schema-"));
  tempDirs.push(home);
  await saveSettings({ home, patch: { cardThreshold: "must" } });
  const text = JSON.parse(await readFile(join(home, SETTINGS_FILE), "utf8"));
  assert.equal(text.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(text.cardThreshold, "must");
  const meta = await loadSettingsWithMeta({ home });
  assert.equal(meta.migrated, false, "写回之后不应再迁移");
});
