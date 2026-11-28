// @ts-check
// 索引生成器的离线单测：不联网、不读真实 packages/，全部用假 packument 与临时目录。
// 规则来源是宿主的 `@deepseek-ai/dsh-plugin-market-index`（见 docs/runtime/0.2.2-rc.3.md
// 与 0.2.2-rc.5.md §23.8），真机验收另外由 `pnpm smoke:index` 覆盖——两边都不绿就不算数。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  buildIndex,
  checkIcons,
  checkMeta,
  collectPackages,
  compareVersions,
  decodeIconDataUrl,
  fetchPackument,
  IndexError,
  iconDataUrl,
  iconDrift,
  isFormalPlugin,
  localIconAudit,
  MAX_INDEX_ICON_BYTES,
  missingPublishedVersions,
  normalizeRepositoryUrl,
  retryDelayMs,
  sha256,
  stableVersions,
  validateIndex,
} from "../build-index.mjs";

/** @type {string[]} */
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** 造一个最小但互不相同的 SVG：内容带标题，用于断言 8 个图标不重复。 */
const svgFor = (/** @type {string} */ label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><title>${label}</title></svg>`;

/**
 * 在临时目录里造一个最小仓库：`packages/<dir>/package.json` + 图标文件（默认 icon.svg）。
 * @param {string[]} dirs
 * @param {{
 *   omitIcon?: string[],
 *   iconBytes?: Record<string, Buffer>,
 *   version?: string,
 *   iconFile?: Record<string, string>,
 *   declaredIcon?: Record<string, string>,
 * }} [options]
 * @returns {string}
 */
function makeRepo(
  dirs,
  { omitIcon = [], iconBytes = {}, version = "1.0.0", iconFile = {}, declaredIcon = {} } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "dsh-index-icons-"));
  roots.push(root);
  mkdirSync(join(root, "packages"), { recursive: true });
  for (const dir of dirs) {
    const base = join(root, "packages", dir);
    mkdirSync(base, { recursive: true });
    const name = `@kangyishuai/dsh-${dir}`;
    /** @type {Record<string, any>} */
    const pkg = {
      name,
      version,
      description: `${name} does one thing.`,
      homepage: "https://github.com/kangyishuai/dsh-plugins/tree/main/packages/x#readme",
      repository: {
        type: "git",
        url: "git+https://github.com/kangyishuai/dsh-plugins.git",
        directory: `packages/${dir}`,
      },
    };
    if (declaredIcon[dir] !== undefined) pkg.icon = declaredIcon[dir];
    writeFileSync(join(base, "package.json"), JSON.stringify(pkg));
    if (!omitIcon.includes(dir)) {
      writeFileSync(join(base, iconFile[dir] ?? "icon.svg"), iconBytes[dir] ?? svgFor(name));
    }
  }
  return root;
}

/** @param {string[]} dirs */
const metaFor = (dirs) => ({
  title: { en: "Test index", zh: "测试索引" },
  description: { en: "Test.", zh: "测试。" },
  categories: { tools: { title: { en: "Tools", zh: "工具" } } },
  plugins: Object.fromEntries(
    dirs.map((dir) => [
      `@kangyishuai/dsh-${dir}`,
      { category: "tools", title: { en: dir, zh: dir }, descriptionZh: `${dir} 插件。` },
    ]),
  ),
});

/** @param {string[]} dirs */
const packumentsFor = (dirs) =>
  new Map(
    dirs.map((dir) => {
      const name = `@kangyishuai/dsh-${dir}`;
      return [
        name,
        {
          name,
          versions: {
            "1.0.0": { version: "1.0.0", dist: { tarball: "https://example.test/x.tgz" } },
          },
          time: { "1.0.0": "2026-01-02T00:00:00.000Z" },
        },
      ];
    }),
  );

const manifest = (/** @type {string} */ name, /** @type {string} */ version) => {
  const iconBytes = Buffer.from(svgFor(name));
  return {
    dir: name.split("/").at(-1)?.replace("dsh-", ""),
    name,
    version,
    description: `${name} does one thing.`,
    homepage: `https://github.com/kangyishuai/dsh-plugins/tree/main/packages/x#readme`,
    repository: {
      type: "git",
      url: "git+https://github.com/kangyishuai/dsh-plugins.git",
      directory: "packages/x",
    },
    // 正式插件都要带图标（发现页卡片从索引条目的 `icon` 读）。
    icon: iconDataUrl(iconBytes, "icon.svg"),
    iconSha256: sha256(iconBytes),
  };
};

const meta = {
  title: { en: "Test index", zh: "测试索引" },
  description: { en: "Test.", zh: "测试。" },
  categories: { session: { title: { en: "Sessions", zh: "会话" } } },
  plugins: {
    "@kangyishuai/dsh-alpha": {
      category: "session",
      title: { en: "Alpha", zh: "阿尔法" },
      descriptionZh: "阿尔法插件。",
    },
    "@kangyishuai/dsh-beta": {
      category: "session",
      title: { en: "Beta", zh: "贝塔" },
      descriptionZh: "贝塔插件。",
    },
  },
};

const packument = (
  /** @type {Record<string, string>} */ times,
  /** @type {Record<string, any>} */ overrides = {},
) => ({
  name: "x",
  time: { created: "2026-01-01T00:00:00.000Z", modified: "2026-02-01T00:00:00.000Z", ...times },
  versions: Object.fromEntries(
    Object.keys(times)
      .filter(
        (version) => version !== "created" && version !== "modified" && version !== "unpublished",
      )
      .map((version) => [
        version,
        {
          version,
          dist: { tarball: `https://example.com/${version}.tgz` },
          ...(overrides[version] ?? {}),
        },
      ]),
  ),
});

const ALPHA = packument({
  "0.1.0": "2026-01-02T00:00:00.000Z",
  "0.2.0": "2026-01-03T00:00:00.000Z",
  "0.3.0-rc.1": "2026-01-04T00:00:00.000Z",
  "0.3.0": "2026-01-05T00:00:00.000Z",
  // 没有发布时间的版本：Discord/CI 里偶发，不能写进索引（宿主需要 Unix 秒）。
  "0.4.0": undefined,
});
const BETA = packument({
  "1.0.0": "2026-01-02T00:00:00.000Z",
  "0.0.0-stage": "2026-01-01T00:00:00.000Z",
});

test("stableVersions：排除预发布、stub、没有发布时间的版本，并按版本降序", () => {
  const versions = stableVersions(ALPHA);
  assert.deepEqual(
    versions.map((item) => item.version),
    ["0.3.0", "0.2.0", "0.1.0"],
  );
  assert.equal(
    versions[0].publishTimestamp,
    Math.floor(Date.parse("2026-01-05T00:00:00.000Z") / 1000),
  );

  const beta = stableVersions(BETA);
  assert.deepEqual(
    beta.map((item) => item.version),
    ["1.0.0"],
    "0.0.0-stage 是预发布，不能出现在可安装清单里",
  );
});

test("stableVersions：stub 占位版本即使没有预发布标记也不列出", () => {
  const doc = packument(
    { "0.1.0": "2026-01-02T00:00:00.000Z", "0.2.0": "2026-01-03T00:00:00.000Z" },
    { "0.2.0": { stub: true } },
  );
  assert.deepEqual(
    stableVersions(doc).map((item) => item.version),
    ["0.1.0"],
  );
});

test("buildIndex：写出 format 1 的完整条目，字段与宿主 validator 的规则一致", () => {
  const index = buildIndex({
    manifests: [
      manifest("@kangyishuai/dsh-alpha", "0.3.0"),
      manifest("@kangyishuai/dsh-beta", "1.0.0"),
    ],
    meta,
    packuments: new Map([
      ["@kangyishuai/dsh-alpha", ALPHA],
      ["@kangyishuai/dsh-beta", BETA],
    ]),
  });

  assert.equal(index.format, 1);
  assert.equal(index.title.en, "Test index");
  assert.deepEqual(index.metadata.categories.session.title, { en: "Sessions", zh: "会话" });
  assert.deepEqual(
    index.plugins.map((/** @type {any} */ plugin) => plugin.name),
    ["@kangyishuai/dsh-alpha", "@kangyishuai/dsh-beta"],
  );

  const alpha = index.plugins[0];
  assert.deepEqual(alpha.title, { en: "Alpha", zh: "阿尔法" });
  assert.deepEqual(alpha.description, {
    en: "@kangyishuai/dsh-alpha does one thing.",
    zh: "阿尔法插件。",
  });
  assert.deepEqual(alpha.repository, {
    url: "https://github.com/kangyishuai/dsh-plugins",
    directory: "packages/x",
  });
  assert.equal(
    alpha.homepage,
    "https://github.com/kangyishuai/dsh-plugins/tree/main/packages/x#readme",
  );
  assert.deepEqual(alpha.metadata, { category: "session" });
  assert.deepEqual(
    alpha.versions.map((/** @type {any} */ version) => version.version),
    ["0.3.0", "0.2.0", "0.1.0"],
  );
  assert.deepEqual(alpha.versions[0].source, { type: "npm" });
  assert.equal(alpha.versions[0].engines, undefined, "按仓库约定不声明 engines.dsh");
});

test("buildIndex：包里的版本还没发到 npm 时直接失败，不生成缺版本的索引", () => {
  assert.throws(
    () =>
      buildIndex({
        manifests: [manifest("@kangyishuai/dsh-alpha", "0.9.0")],
        meta: {
          ...meta,
          plugins: { "@kangyishuai/dsh-alpha": meta.plugins["@kangyishuai/dsh-alpha"] },
        },
        packuments: new Map([["@kangyishuai/dsh-alpha", ALPHA]]),
      }),
    /还没有发布到 npm/u,
  );
});

test("buildIndex：registry 上整体撤回的包不写进索引", () => {
  assert.throws(
    () =>
      buildIndex({
        manifests: [manifest("@kangyishuai/dsh-alpha", "0.3.0")],
        meta: {
          ...meta,
          plugins: { "@kangyishuai/dsh-alpha": meta.plugins["@kangyishuai/dsh-alpha"] },
        },
        packuments: new Map([
          [
            "@kangyishuai/dsh-alpha",
            {
              ...ALPHA,
              time: { ...ALPHA.time, unpublished: { time: "2026-02-01T00:00:00.000Z" } },
            },
          ],
        ]),
      }),
    /已被整体撤回/u,
  );
});

test("checkMeta：缺条目、多条目、未声明分类、缺中文描述都能点名", () => {
  const missing = checkMeta([manifest("@kangyishuai/dsh-alpha", "0.3.0")], {
    ...meta,
    plugins: {},
  });
  assert.match(missing.join("\n"), /缺少 @kangyishuai\/dsh-alpha/u);

  const extra = checkMeta([], {
    ...meta,
    plugins: { "@kangyishuai/dsh-gone": meta.plugins["@kangyishuai/dsh-alpha"] },
  });
  assert.match(extra.join("\n"), /找不到对应插件目录/u);

  const badCategory = checkMeta([manifest("@kangyishuai/dsh-alpha", "0.3.0")], {
    ...meta,
    plugins: {
      "@kangyishuai/dsh-alpha": { ...meta.plugins["@kangyishuai/dsh-alpha"], category: "nope" },
    },
  });
  assert.match(badCategory.join("\n"), /没有在 categories 里声明/u);

  const noZh = checkMeta([manifest("@kangyishuai/dsh-alpha", "0.3.0")], {
    ...meta,
    plugins: {
      "@kangyishuai/dsh-alpha": { ...meta.plugins["@kangyishuai/dsh-alpha"], descriptionZh: " " },
    },
  });
  assert.match(noZh.join("\n"), /缺少 descriptionZh/u);
});

test("normalizeRepositoryUrl：去掉 git+ 与 .git，拒绝 http", () => {
  assert.equal(
    normalizeRepositoryUrl("git+https://github.com/kangyishuai/dsh-plugins.git"),
    "https://github.com/kangyishuai/dsh-plugins",
  );
  assert.equal(normalizeRepositoryUrl("https://github.com/a/b/"), "https://github.com/a/b");
  assert.throws(() => normalizeRepositoryUrl("http://github.com/a/b"), /必须是 https/u);
});

test("compareVersions：按数字比大小，而不是按字符串", () => {
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-rc.1") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("validateIndex：宿主会拒的形态在这里也拒", () => {
  const good = buildIndex({
    manifests: [manifest("@kangyishuai/dsh-alpha", "0.3.0")],
    meta: {
      ...meta,
      plugins: { "@kangyishuai/dsh-alpha": meta.plugins["@kangyishuai/dsh-alpha"] },
    },
    packuments: new Map([["@kangyishuai/dsh-alpha", ALPHA]]),
  });
  assert.doesNotThrow(() => validateIndex(good));

  const clone = () => JSON.parse(JSON.stringify(good));
  const reject = (/** @type {(value: any) => void} */ mutate, /** @type {RegExp} */ reason) => {
    const broken = clone();
    mutate(broken);
    assert.throws(() => validateIndex(broken), reason);
  };

  reject((value) => (value.format = 2), /必须是 1/u);
  reject((value) => (value.plugins[0].versions = []), /非空数组/u);
  reject((value) => value.plugins[0].versions.push({ ...value.plugins[0].versions[0] }), /重复/u);
  reject((value) => (value.plugins[0].metadata.category = "nope"), /未声明/u);
  reject((value) => (value.plugins[0].versions[0].version = "v1"), /精确 SemVer/u);
  reject((value) => (value.plugins[0].versions[0].publishTimestamp = 1.5), /Unix 秒/u);
  reject((value) => (value.plugins[0].repository.url = "https://GitHub.com/a/b"), /canonical/u);
  reject((value) => (value.plugins[0].repository.directory = "../etc"), /安全相对目录/u);
  reject((value) => (value.plugins[0].name = "Not A Package"), /合法的 npm 包名/u);
  reject((value) => delete value.plugins[0].description.en, /必须包含 en/u);

  const error = (() => {
    try {
      validateIndex({
        format: 1,
        title: "x",
        metadata: {},
        plugins: [
          {
            name: "@a/b",
            versions: [{ version: "1.0", publishTimestamp: 1, source: { type: "npm" } }],
          },
        ],
      });
    } catch (caught) {
      return caught;
    }
    return null;
  })();
  assert.ok(error instanceof IndexError);
  assert.equal(/** @type {IndexError} */ (error).path, "$.plugins[0].versions[0].version");
});

// --- fetchPackument：新包 404 的长退避（2026-11-17 发版事故回归）----------------
//
// 事故：首次发布新包后，index.yml 在 release 后 22 秒启动，registry 对新包还没传播完
// （npm 提示 "being processed and may take a few minutes"，实测约 8 分钟），
// 当时只用 4 秒的重试窗口 → 索引构建硬失败。这里锁住「404 走长退避」的行为。

/** 造一个按脚本回应 status 的假 fetch，并记录调用次数。 */
const fakeFetch = (/** @type {number[]} */ statuses) => {
  let index = 0;
  /** @type {number[]} */
  const calls = [];
  const impl = async () => {
    calls.push(index);
    const status = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ name: "x", versions: {} }),
    };
  };
  return { impl, calls };
};

test("fetchPackument：404 持续重试直到 registry 传播完（长退避）", async () => {
  const { impl, calls } = fakeFetch([404, 404, 404, 200]);
  /** @type {number[]} */
  const sleeps = [];
  const packument = await fetchPackument("@x/y", {
    fetchImpl: /** @type {any} */ (impl),
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    notFoundAttempts: 12,
    notFoundDelayMs: 20_000,
    registry: "https://registry.example",
  });
  assert.equal(packument.name, "x");
  assert.equal(calls.length, 4, "3 次 404 后第 4 次成功");
  assert.deepEqual(sleeps, [20_000, 40_000, 60_000], "退避递增并封顶 60s");
});

test("fetchPackument：404 超过上限才失败，且错误信息带 HTTP 404", async () => {
  const { impl, calls } = fakeFetch([404]);
  await assert.rejects(
    () =>
      fetchPackument("@x/y", {
        fetchImpl: /** @type {any} */ (impl),
        sleepImpl: async () => {},
        notFoundAttempts: 3,
        notFoundDelayMs: 1000,
        registry: "https://registry.example",
      }),
    /HTTP 404/,
  );
  assert.equal(calls.length, 3, "达到上限即停");
});

test("fetchPackument：非 404 错误快速失败（不拖十分钟）", async () => {
  const { impl, calls } = fakeFetch([500]);
  /** @type {number[]} */
  const sleeps = [];
  await assert.rejects(
    () =>
      fetchPackument("@x/y", {
        fetchImpl: /** @type {any} */ (impl),
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
        attempts: 3,
        notFoundAttempts: 99,
        registry: "https://registry.example",
      }),
    /HTTP 500/,
  );
  assert.equal(calls.length, 3, "非 404 只试 attempts 次");
  assert.deepEqual(sleeps, [1000, 2000], "非 404 的退避是秒级");
});

test("retryDelayMs：递增并封顶", () => {
  assert.equal(retryDelayMs(1, 20_000), 20_000);
  assert.equal(retryDelayMs(2, 20_000), 40_000);
  assert.equal(retryDelayMs(3, 20_000), 60_000);
  assert.equal(retryDelayMs(10, 20_000), 60_000, "封顶 60s");
});

// --- 发版后「版本还没传播」的等待（2026-11-17 线上事故回归）--------------------
//
// 事故：release 发布 0.1.1 / 0.2.0 / 0.3.0 后，index.yml 各失败一次，错误都是
// 「还没有发布到 npm（registry 上是旧版本）」。原因不是 404（fetchPackument 的重试
// 覆盖那种情况），而是 packument 返回 200 但内容还是旧的。

/** 造一个只含指定版本的 packument。 */
const packumentWith = (/** @type {string} */ name, /** @type {string[]} */ versions) => ({
  name,
  // stableVersions 要求 dist.tarball 是字符串、time 可解析，否则视为不可列出。
  versions: Object.fromEntries(
    versions.map((v) => [
      v,
      { version: v, dist: { tarball: `https://example.test/${name}-${v}.tgz` } },
    ]),
  ),
  time: Object.fromEntries(versions.map((v) => [v, "2026-11-17T00:00:00.000Z"])),
});

test("missingPublishedVersions：registry 落后时指出具体包与当前最新版", () => {
  const manifests = [{ name: "@x/btw", version: "0.3.0" }];
  const packuments = new Map([["@x/btw", packumentWith("@x/btw", ["0.1.0", "0.2.0"])]]);
  assert.deepEqual(missingPublishedVersions(manifests, packuments), [
    { name: "@x/btw", version: "0.3.0", latest: "0.2.0" },
  ]);
});

test("missingPublishedVersions：版本已出现时返回空（不误报）", () => {
  const manifests = [{ name: "@x/btw", version: "0.3.0" }];
  const packuments = new Map([["@x/btw", packumentWith("@x/btw", ["0.2.0", "0.3.0"])]]);
  assert.deepEqual(missingPublishedVersions(manifests, packuments), []);
});

test("missingPublishedVersions：packument 完全没有也算缺失", () => {
  const missing = missingPublishedVersions([{ name: "@x/y", version: "1.0.0" }], new Map());
  assert.equal(missing.length, 1);
  assert.equal(missing[0].latest, "(无数据)");
});

// --- 索引图标：发现页卡片的图标来自索引条目 `icon`（docs/runtime/0.2.2-rc.5.md §23.8）---
//
// 宿主 `@deepseek-ai/dsh-plugin-market-index` 的规则（src/index.ts 的 `icon()`）：
// icon 可省略；内联形态必须是 **base64** 的 SVG/PNG/JPEG/WebP data URL，解码后 ≤32 KiB；
// URI 编码的 data URL 或别的 MIME 会让整份索引被拒收（`plugin-market/invalid-index`）。
// 发现页用 36px 渲染（48px 帧），加载失败才回退通用图形——所以「索引里带了 icon 但内容坏」
// 会静默降级，必须由本仓库的 check/单测提前拦住。

test("图标：8 个插件全部内联为 data URL，解回来与本地 icon.svg 逐字节一致且互不相同", () => {
  const dirs = [
    "advisor",
    "artifacts",
    "btw",
    "casefile",
    "next-step",
    "projects",
    "session-delete",
    "session-rewind",
  ];
  const root = makeRepo(dirs);
  const manifests = collectPackages(root);
  assert.equal(manifests.length, 8);
  for (const item of manifests) {
    assert.ok(typeof item.icon === "string", `${item.name} 应有内联图标`);
    assert.match(item.icon, /^data:image\/svg\+xml;base64,/u);
    const bytes = decodeIconDataUrl(item.icon, `${item.name}.icon`);
    assert.equal(bytes.toString("utf8"), svgFor(item.name), "解码后必须与 icon.svg 字节一致");
    assert.equal(sha256(bytes), item.iconSha256, "sha256 必须对应本地文件字节");
  }
  assert.equal(
    new Set(manifests.map((item) => item.iconSha256)).size,
    8,
    "8 个图标必须互不相同（发现页要能区分插件）",
  );

  const index = buildIndex({ manifests, meta: metaFor(dirs), packuments: packumentsFor(dirs) });
  assert.equal(index.plugins.length, 8);
  assert.equal(
    new Set(index.plugins.map((/** @type {any} */ plugin) => plugin.icon)).size,
    8,
    "写进索引的 8 个图标也必须互不相同",
  );
  // 落盘再读回的形态（--check 校验的就是它）仍然合法。
  assert.doesNotThrow(() => validateIndex(JSON.parse(JSON.stringify(index))));
});

test("图标：缺 icon 文件时正式插件报错、0.0.0 脚手架只告警，buildIndex 拒绝生成索引", () => {
  const root = makeRepo(["alpha"], { omitIcon: ["alpha"] });
  const [missing] = collectPackages(root);
  assert.equal(missing.icon, undefined);
  assert.match(String(missing.iconError), /icon\.svg 不存在/u);

  const formal = checkIcons([missing], metaFor(["alpha"]));
  assert.equal(formal.warnings.length, 0);
  assert.match(formal.errors.join("\n"), /没有可用的图标/u);
  assert.match(formal.errors.join("\n"), /发现页退回通用图形/u);

  // `pnpm new` 生成的 0.0.0 脚手架还没有图标是常态：不能因此把 `pnpm check` 弄红。
  const scaffold = makeRepo(["scaffold"], { omitIcon: ["scaffold"], version: "0.0.0" });
  const scaffoldAudit = checkIcons(collectPackages(scaffold), metaFor(["scaffold"]));
  assert.equal(scaffoldAudit.errors.length, 0);
  assert.match(scaffoldAudit.warnings.join("\n"), /0\.0\.0 脚手架/u);

  assert.throws(
    () =>
      buildIndex({
        manifests: [missing],
        meta: metaFor(["alpha"]),
        packuments: packumentsFor(["alpha"]),
      }),
    /缺少可内联的图标/u,
  );
});

test("图标：超过宿主 32 KiB 上限时报错（源文件与已编码 data URL 两条路都拦）", () => {
  assert.equal(MAX_INDEX_ICON_BYTES, 32 * 1024, "必须等于宿主的 MAX_INLINE_ICON_BYTES");
  const oversized = Buffer.concat([
    Buffer.from("<svg/>"),
    Buffer.alloc(MAX_INDEX_ICON_BYTES + 1, 0x20),
  ]);
  assert.throws(() => iconDataUrl(oversized, "packages/big/icon.svg"), /超过宿主内联图标上限/u);

  const encoded = `data:image/svg+xml;base64,${oversized.toString("base64")}`;
  assert.throws(() => decodeIconDataUrl(encoded, "$.icon"), /宿主上限/u);

  // 边界：解码后正好 32 KiB 仍然合法（宿主是 `> MAX` 才拒）。
  const exact = Buffer.concat([
    Buffer.from("<svg/>"),
    Buffer.alloc(MAX_INDEX_ICON_BYTES - 6, 0x20),
  ]);
  const dataUrl = iconDataUrl(exact, "packages/exact/icon.svg");
  assert.equal(decodeIconDataUrl(dataUrl, "$.icon").length, MAX_INDEX_ICON_BYTES);
});

test("图标：坏 SVG 头被拒；XML 声明与注释之后的 <svg 可以", () => {
  assert.throws(() => iconDataUrl(Buffer.alloc(0), "icon.svg"), /空文件/u);
  assert.throws(
    () => iconDataUrl(Buffer.from("<!doctype html><html><body></body></html>"), "icon.svg"),
    /文件头不是 image\/svg\+xml/u,
  );
  assert.throws(
    () => iconDataUrl(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "icon.svg"),
    /文件头不是 image\/svg\+xml/u,
  );
  const withProlog = Buffer.from(
    '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- icon -->\n<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  assert.match(iconDataUrl(withProlog, "icon.svg"), /^data:image\/svg\+xml;base64,/u);
});

test("图标：非法 data URL 被拒（URI 编码、非 base64、MIME 不在白名单、坏 payload）", () => {
  const rejected = [
    "data:image/svg+xml,%3Csvg%3E", // URI 编码：宿主只收 base64
    "data:image/svg+xml;utf8,<svg/>",
    "data:image/gif;base64,R0lGODdh",
    "data:image/svg+xml;base64,not-base64!!!",
    "data:image/svg+xml;base64,",
    "https://example.test/icon.svg",
    "",
  ];
  for (const value of rejected) {
    assert.throws(() => decodeIconDataUrl(value, "$.icon"), IndexError);
  }

  const root = makeRepo(["alpha"]);
  const [alphaManifest] = collectPackages(root);
  const index = buildIndex({
    manifests: [alphaManifest],
    meta: metaFor(["alpha"]),
    packuments: packumentsFor(["alpha"]),
  });
  const broken = JSON.parse(JSON.stringify(index));
  broken.plugins[0].icon = "data:image/svg+xml,%3Csvg%3E";
  const error = (() => {
    try {
      validateIndex(broken);
    } catch (caught) {
      return caught;
    }
    return null;
  })();
  assert.ok(error instanceof IndexError);
  assert.equal(/** @type {IndexError} */ (error).path, "$.plugins[0].icon");
});

test("图标：iconDrift / localIconAudit 拦住「索引过期、图标没重建」", () => {
  const dirs = ["alpha", "beta"];
  const manifests = collectPackages(makeRepo(dirs));
  const index = buildIndex({ manifests, meta: metaFor(dirs), packuments: packumentsFor(dirs) });

  const good = iconDrift(index, manifests);
  assert.deepEqual(good.errors, []);
  assert.equal(good.icons.length, 2);
  assert.equal(
    good.totalBytes,
    manifests.reduce(
      (sum, item) => sum + decodeIconDataUrl(item.icon, `${item.name}.icon`).length,
      0,
    ),
  );

  // 线上那份索引还没有 icon 字段时必须报错，而不是静默用默认图。
  const stale = JSON.parse(JSON.stringify(index));
  for (const plugin of stale.plugins) delete plugin.icon;
  const staleDrift = iconDrift(stale, manifests);
  assert.equal(staleDrift.errors.length, 2);
  assert.match(staleDrift.errors.join("\n"), /没有 icon/u);

  // 改了 icon.svg 却忘了重建索引（sha256 对不上）。
  const changed = JSON.parse(JSON.stringify(index));
  changed.plugins[0].icon = iconDataUrl(Buffer.from(svgFor("changed")), "icon.svg");
  assert.match(iconDrift(changed, manifests).errors.join("\n"), /不一致/u);

  // 索引里少一个本仓库插件。
  const incomplete = JSON.parse(JSON.stringify(index));
  incomplete.plugins = incomplete.plugins.slice(0, 1);
  assert.match(iconDrift(incomplete, manifests).errors.join("\n"), /索引里没有/u);

  // 本地转换写坏（内存结果与 icon.svg 的 sha256 对不上）。
  const tampered = manifests.map((item, position) =>
    position === 0
      ? { ...item, icon: iconDataUrl(Buffer.from(svgFor("tampered")), "icon.svg") }
      : item,
  );
  assert.match(localIconAudit(tampered).errors.join("\n"), /内联图标与本地 .*icon\.svg 不一致/u);
  assert.deepEqual(localIconAudit(manifests).errors, []);
});

test("图标：同长度内容改动必须报 sha256 不一致（不能只比长度或存在性）", () => {
  const manifests = collectPackages(makeRepo(["alpha"]));
  const index = buildIndex({
    manifests,
    meta: metaFor(["alpha"]),
    packuments: packumentsFor(["alpha"]),
  });
  const original = decodeIconDataUrl(index.plugins[0].icon, "icon");
  // 只把标题里的 alpha 改成 alphb：字节数完全相同，sha256 必须变。
  const mutatedBytes = Buffer.from(
    original.toString("utf8").replace("@kangyishuai/dsh-alpha", "@kangyishuai/dsh-alphb"),
  );
  assert.equal(mutatedBytes.length, original.length, "构造的改动必须长度相同");

  const mutatedIndex = JSON.parse(JSON.stringify(index));
  mutatedIndex.plugins[0].icon = iconDataUrl(mutatedBytes, "icon.svg");
  assert.match(iconDrift(mutatedIndex, manifests).errors.join("\n"), /不一致/u);

  const tampered = [{ ...manifests[0], icon: iconDataUrl(mutatedBytes, "icon.svg") }];
  assert.match(localIconAudit(tampered).errors.join("\n"), /不一致/u);
});

test("图标：base64 长度不是 4 的倍数必须拒（AAAAA 不能靠宽松解码蒙混）", () => {
  for (const value of ["data:image/svg+xml;base64,AAAAA", "data:image/png;base64,AAAAA"]) {
    const error = (() => {
      try {
        decodeIconDataUrl(value, "$.icon");
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    assert.ok(error instanceof IndexError, `${value} 应被拒绝`);
    assert.equal(/** @type {IndexError} */ (error).path, "$.icon");
  }
});

test("图标：iconDrift 双向核对 name 集合，索引里多出的 ghost 插件要点名", () => {
  const dirs = ["alpha", "beta"];
  const manifests = collectPackages(makeRepo(dirs));
  const index = buildIndex({ manifests, meta: metaFor(dirs), packuments: packumentsFor(dirs) });

  const ghost = JSON.parse(JSON.stringify(index));
  ghost.plugins.push({ ...ghost.plugins[0], name: "@kangyishuai/dsh-ghost" });
  const drift = iconDrift(ghost, manifests);
  assert.equal(drift.errors.length, 1);
  assert.match(
    drift.errors.join("\n"),
    /@kangyishuai\/dsh-ghost 在索引里但 packages\/ 下没有对应插件/u,
  );

  assert.deepEqual(iconDrift(index, manifests).errors, []);
});

test("图标：0.0.0 脚手架还没进索引时 --check 不硬报错（只要求正式插件）", () => {
  const formalManifests = collectPackages(makeRepo(["alpha"]));
  const scaffold = collectPackages(makeRepo(["scaffold"], { version: "0.0.0" }))[0];
  const formalMeta = metaFor(["alpha"]);
  const index = buildIndex({
    manifests: formalManifests,
    meta: formalMeta,
    packuments: packumentsFor(["alpha"]),
  });
  const formalNames = new Set(
    formalManifests.filter((manifest) => isFormalPlugin(manifest, formalMeta)).map((m) => m.name),
  );

  // 脚手架没登记（或仍是 0.0.0）：不在索引里也不算错。
  assert.deepEqual(iconDrift(index, [...formalManifests, scaffold], formalNames).errors, []);
  // 反证：默认「全部必需」时同一个索引会点出脚手架缺条目。
  assert.match(
    iconDrift(index, [...formalManifests, scaffold]).errors.join("\n"),
    /索引里没有 @kangyishuai\/dsh-scaffold/u,
  );
  // 正式插件缺失仍然必须报错。
  const empty = { format: 1, title: "x", metadata: {}, plugins: [] };
  assert.match(
    iconDrift(empty, formalManifests, formalNames).errors.join("\n"),
    /索引里没有 @kangyishuai\/dsh-alpha/u,
  );
});

test("图标：0.0.0 脚手架仍在用模板占位图标时只告警（模板已自带 icon.svg）", () => {
  const root = makeRepo(["scaffold"], { version: "0.0.0" });
  mkdirSync(join(root, "templates", "plugin"), { recursive: true });
  const placeholder = Buffer.from(svgFor("Plugin placeholder"));
  writeFileSync(join(root, "templates", "plugin", "icon.svg"), placeholder);
  writeFileSync(join(root, "packages", "scaffold", "icon.svg"), placeholder);

  const manifest = collectPackages(root)[0];
  assert.equal(manifest.iconIsTemplatePlaceholder, true);
  const audit = checkIcons([manifest], metaFor(["scaffold"]));
  assert.equal(audit.errors.length, 0);
  assert.match(audit.warnings.join("\n"), /模板占位图标/u);
  assert.match(audit.warnings.join("\n"), /发版前替换/u);
});

test("图标：从 package.json#icon 推导文件（默认 icon.svg，png 按对应 MIME 内联）", () => {
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("fake-png-payload"),
  ]);
  const root = makeRepo(["alpha"], {
    iconFile: { alpha: "icon.png" },
    iconBytes: { alpha: pngBytes },
    declaredIcon: { alpha: "icon.png" },
  });
  const [alphaManifest] = collectPackages(root);
  assert.ok(typeof alphaManifest.icon === "string");
  assert.match(alphaManifest.icon, /^data:image\/png;base64,/u);
  assert.equal(alphaManifest.iconPath, "packages/alpha/icon.png");
  const bytes = decodeIconDataUrl(alphaManifest.icon, "icon");
  assert.deepEqual(bytes, pngBytes);
  assert.equal(sha256(bytes), alphaManifest.iconSha256);

  const index = buildIndex({
    manifests: [alphaManifest],
    meta: metaFor(["alpha"]),
    packuments: packumentsFor(["alpha"]),
  });
  assert.doesNotThrow(() => validateIndex(JSON.parse(JSON.stringify(index))));
  assert.deepEqual(iconDrift(index, [alphaManifest]).errors, []);
});

test("图标：package.json#icon 逃出包目录 / 扩展名不支持 / 文件头不符都点名拒绝", () => {
  const escapedPath = collectPackages(
    makeRepo(["alpha"], { declaredIcon: { alpha: "../escape.svg" } }),
  )[0];
  assert.match(String(escapedPath.iconError), /包目录内的相对路径/u);
  assert.equal(escapedPath.icon, undefined);

  const unsupported = collectPackages(
    makeRepo(["beta"], { iconFile: { beta: "icon.gif" }, declaredIcon: { beta: "icon.gif" } }),
  )[0];
  assert.match(String(unsupported.iconError), /扩展名必须是 svg\/png\/jpg\/jpeg\/webp/u);

  // 声明 png 但内容是 SVG：文件头校验必须拦住（否则浏览器静默回退通用图形）。
  const headerMismatch = collectPackages(
    makeRepo(["gamma"], {
      iconFile: { gamma: "icon.png" },
      iconBytes: { gamma: Buffer.from(svgFor("gamma")) },
      declaredIcon: { gamma: "icon.png" },
    }),
  )[0];
  assert.match(String(headerMismatch.iconError), /文件头不是 image\/png/u);
});
