// @ts-check
// 索引生成器的离线单测：不联网、不读真实 packages/，全部用假 packument 与临时目录。
// 规则来源是宿主的 `@deepseek-ai/dsh-plugin-market-index`（见 docs/runtime/0.2.2-rc.3.md），
// 真机验收另外由 `pnpm smoke:index` 覆盖——两边都不绿就不算数。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIndex,
  checkMeta,
  compareVersions,
  IndexError,
  normalizeRepositoryUrl,
  stableVersions,
  validateIndex,
} from "../build-index.mjs";

const manifest = (/** @type {string} */ name, /** @type {string} */ version) => ({
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
});

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
