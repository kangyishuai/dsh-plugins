// @ts-check
// AUD-PROJ-24：项目级默认模型的可用性校验。
//
// 真实数据里 `thread/model-default-failed` 出现过 5 次（换 provider 后默认模型失效），
// 而旧实现只在 createThread 里写一条审计，界面上完全无感。这里锁纯函数判定：
// 目录拿不到时不校验（不能因为读不到目录就把设置拦死），拿到就明确拒绝不在目录里的模型。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  catalogChoices,
  checkCatalogChoice,
  modelUnavailableMessage,
} from "../lib/model-choice.js";

/** 与 client.js 渲染口径一致的宿主目录形状。 */
const catalog = {
  available: true,
  groups: [
    {
      id: "deepseek",
      models: [{ id: "deepseek-v4" }, { id: "deepseek-v4-mini", reasoning: { efforts: ["low"] } }],
    },
    { provider: "acme", models: ["acme-1"] },
  ],
};

describe("catalogChoices：摊平宿主目录（结构不认识就是空）", () => {
  it("recognizes groups[].id/provider + models[].id/字符串", () => {
    assert.deepEqual(catalogChoices(catalog), [
      { provider: "deepseek", model: "deepseek-v4" },
      { provider: "deepseek", model: "deepseek-v4-mini" },
      { provider: "acme", model: "acme-1" },
    ]);
    assert.deepEqual(catalogChoices(null), []);
    assert.deepEqual(catalogChoices({ groups: [{ models: [{ nope: 1 }] }] }), []);
  });
});

describe("checkCatalogChoice：三态判定", () => {
  it("命中 → found", () => {
    assert.deepEqual(checkCatalogChoice(catalog, { provider: "deepseek", model: "deepseek-v4" }), {
      checked: true,
      found: true,
      reason: "",
    });
    // provider 只给模型名也能命中（宿主目录的 provider 字段不稳）
    assert.equal(checkCatalogChoice(catalog, { model: "acme-1" }).found, true);
  });

  it("不在目录里 → checked 但 not found（写入口应拒绝）", () => {
    const verdict = checkCatalogChoice(catalog, { provider: "deepseek", model: "gone-model" });
    assert.equal(verdict.checked, true);
    assert.equal(verdict.found, false);
    assert.equal(verdict.reason, "model/unavailable");
  });

  it("目录拿不到/空 → 不校验（不能因为读不到目录就拦死）", () => {
    for (const empty of [null, undefined, { available: false, groups: [] }, { groups: [] }]) {
      const verdict = checkCatalogChoice(empty, { model: "whatever" });
      assert.equal(verdict.checked, false);
      assert.equal(verdict.found, false);
      assert.equal(verdict.reason, "catalog-unavailable");
    }
    assert.equal(checkCatalogChoice(catalog, { model: "  " }).reason, "model/empty");
  });

  it("拒绝时的可读原因包含 provider/model 与恢复方式", () => {
    const message = modelUnavailableMessage({ provider: "acme", model: "gone" });
    assert.match(message, /acme\/gone/u);
    assert.match(message, /model-unavailable/u);
    assert.match(message, /inherit the host default/u);
  });
});
