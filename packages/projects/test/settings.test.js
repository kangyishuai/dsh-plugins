// @ts-check
// 「改本插件自己的配置」白名单：只放行非安全键，安全面一律拒（规格 §7.5 行 5a/5b）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applySettingsPatch,
  EDITABLE_KEYS,
  FORBIDDEN_KEYS,
  sanitizeSettingsPatch,
} from "../lib/settings.js";

describe("sanitizeSettingsPatch", () => {
  it("允许 persona / goal / routing", () => {
    assert.deepEqual(sanitizeSettingsPatch({ persona: "你是协调器" }), {
      ok: true,
      patch: { persona: "你是协调器" },
      keys: ["persona"],
    });
    const routing = sanitizeSettingsPatch({
      routing: { rules: [{ id: "r1", when: "问句", action: "answer-inline" }], fallback: false },
    });
    assert.equal(routing.ok, true);
    assert.equal(routing.ok ? routing.patch.routing.fallback : null, false);
  });

  it("明确禁止的键要给出可读理由（自我提权防线）", () => {
    for (const key of FORBIDDEN_KEYS) {
      const result = sanitizeSettingsPatch({ [key]: true });
      assert.equal(result.ok, false, `${key} 应被拒`);
      assert.match(result.ok ? "" : result.reason, new RegExp(`settings/forbidden:${key}`, "u"));
    }
  });

  it("不在白名单里的未知键也拒", () => {
    const result = sanitizeSettingsPatch({ somethingElse: 1 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.reason, /settings\/not-editable/u);
  });

  it("空补丁 / 非对象 / 数组都拒", () => {
    assert.equal(sanitizeSettingsPatch({}).ok, false);
    assert.equal(sanitizeSettingsPatch(null).ok, false);
    assert.equal(sanitizeSettingsPatch([]).ok, false);
    assert.equal(sanitizeSettingsPatch("x").ok, false);
  });

  it("类型不合法要拒（避免把 routing 写成字符串）", () => {
    assert.equal(sanitizeSettingsPatch({ persona: 1 }).ok, false);
    assert.equal(sanitizeSettingsPatch({ goal: {} }).ok, false);
    assert.equal(sanitizeSettingsPatch({ routing: "x" }).ok, false);
    assert.equal(sanitizeSettingsPatch({ routing: { rules: [{ id: 1 }] } }).ok, false);
  });

  it("白名单与禁止清单不重叠", () => {
    for (const key of EDITABLE_KEYS) {
      assert.ok(!FORBIDDEN_KEYS.includes(key), `${key} 不能同时在两份清单里`);
    }
  });
});

describe("applySettingsPatch", () => {
  it("只覆盖补丁里的键，其它策略原样保留", () => {
    const policy = {
      autonomy: "L1",
      persona: "旧",
      danger: { autoMerge: false },
      routing: { rules: [], fallback: true },
    };
    const next = applySettingsPatch(policy, { persona: "新" });
    assert.equal(next.persona, "新");
    assert.equal(next.autonomy, "L1");
    assert.deepEqual(next.danger, { autoMerge: false });
    assert.deepEqual(policy.danger, { autoMerge: false }, "不能改动入参");
  });
});
