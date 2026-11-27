// @ts-check
// F52 权限收窄单测：preset 名是部署配置（不能写死），翻译靠 {sandbox, approval} 的 bundle。
// 方向：本部署默认 danger-full-access + never，所以「收窄」= 选更小的 sandbox / 更勤的询问。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPROVAL_LABELS,
  describePresetSpec,
  fallbackSessionEvents,
  INHERIT_PRESET,
  inheritOption,
  PRESET_SAFETY_NOTES,
  planPresetApplication,
  relationToDefault,
  SANDBOX_LABELS,
  summarizeCatalog,
  verifyPresetApplication,
} from "../lib/permission-narrow.js";

/** 本部署实测的 catalog 形状（名字来自宿主，测试里只是夹具）。 */
const catalog = {
  options: [
    { value: "read-only", name: "Read only" },
    { value: "workspace-write", name: "Workspace write" },
    { value: "danger-full-access", name: "Danger full access" },
    { value: "auto", name: "Auto" },
  ],
  defaultOptions: [
    { value: "workspace-write", name: "Workspace write" },
    { value: "danger-full-access", name: "Danger full access" },
    { value: "auto", name: "Auto" },
  ],
  defaultPreset: "danger-full-access",
};

/** @type {Record<string, { sandbox: string, approval: string }>} */
const specs = {
  "read-only": { sandbox: "read-only", approval: "ask" },
  "workspace-write": { sandbox: "workspace-write", approval: "ask" },
  "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
  auto: { sandbox: "workspace-write", approval: "never" },
};

describe("describePresetSpec", () => {
  it("三档人话 + 询问方式", () => {
    assert.equal(describePresetSpec(specs["read-only"]).kind, "read-only");
    assert.equal(describePresetSpec(specs["read-only"]).label, "只读");
    assert.equal(describePresetSpec(specs["workspace-write"]).kind, "workspace-write");
    assert.equal(describePresetSpec(specs["danger-full-access"]).kind, "full-access");
    assert.match(describePresetSpec(specs["danger-full-access"]).detail, /从不询问/u);
    assert.match(describePresetSpec(specs["workspace-write"]).detail, /逐次询问/u);
  });

  it("认不出的组合标「自定义」，不硬塞到某一档", () => {
    assert.equal(
      describePresetSpec({ sandbox: "read-only", approval: "sometimes" }).kind,
      "custom",
    );
    assert.equal(describePresetSpec(undefined).kind, "custom");
  });

  it("sandbox / approval 的标签表覆盖宿主的全部词表", () => {
    assert.deepEqual(Object.keys(SANDBOX_LABELS), [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    assert.deepEqual(Object.keys(APPROVAL_LABELS), ["ask", "never"]);
  });
});

describe("relationToDefault（相对宿主默认是收窄还是放宽）", () => {
  it("默认是全权限 → read-only / workspace-write 都是收窄", () => {
    assert.equal(relationToDefault(specs["read-only"], specs["danger-full-access"]), "narrower");
    assert.equal(
      relationToDefault(specs["workspace-write"], specs["danger-full-access"]),
      "narrower",
    );
    assert.equal(
      relationToDefault(specs["danger-full-access"], specs["danger-full-access"]),
      "same",
    );
  });

  it("沙箱更窄但审批更松是 mixed（两个旋钮不同向）", () => {
    assert.equal(
      relationToDefault({ sandbox: "read-only", approval: "never" }, specs["danger-full-access"]),
      "narrower",
    );
    assert.equal(
      relationToDefault({ sandbox: "danger-full-access", approval: "never" }, specs["read-only"]),
      "wider",
    );
    assert.equal(
      relationToDefault(
        { sandbox: "read-only", approval: "ask" },
        { sandbox: "workspace-write", approval: "never" },
      ),
      "narrower",
    );
    assert.equal(relationToDefault(undefined, specs["danger-full-access"]), "unknown");
  });
});

describe("summarizeCatalog", () => {
  it("选项名字一律来自 catalog（不写死），并标出默认档与相对关系", () => {
    const summary = summarizeCatalog(catalog, (name) => specs[name]);
    assert.deepEqual(
      summary.options.map((option) => option.name),
      ["read-only", "workspace-write", "danger-full-access", "auto"],
    );
    assert.equal(summary.defaultPreset, "danger-full-access");
    const readOnly = summary.options.find((option) => option.name === "read-only");
    assert.equal(readOnly.relation, "narrower");
    assert.equal(readOnly.isDefault, false);
    const full = summary.options.find((option) => option.name === "danger-full-access");
    assert.equal(full.isDefault, true);
    assert.equal(full.relation, "same");
  });

  it("resolve 抛错时该档位退化成「自定义」，其余照常列出", () => {
    const summary = summarizeCatalog(catalog, (name) => {
      if (name === "auto") throw new Error("boom");
      return specs[name];
    });
    assert.equal(summary.options.length, 4);
    assert.equal(summary.options.find((option) => option.name === "auto").kind, "custom");
  });

  it("「继承宿主」是第一项，文案里带默认档名（读不到也不编）", () => {
    const option = inheritOption(
      { kind: "full-access", label: "全权限", detail: "" },
      "danger-full-access",
    );
    assert.equal(option.name, INHERIT_PRESET);
    assert.match(option.label, /继承宿主/u);
    assert.match(option.detail, /全权限/u);
    assert.match(
      inheritOption({ kind: "custom", label: "未知", detail: "" }, "").detail,
      /宿主默认/u,
    );
  });
});

describe("planPresetApplication / verifyPresetApplication", () => {
  const names = catalog.options.map((option) => option.value);

  it("空串 = 继承（什么都不做）", () => {
    assert.deepEqual(planPresetApplication({ preset: "", catalogNames: names }), {
      mode: "inherit",
    });
  });

  it("名字在 catalog 里 → set(session, name)", () => {
    assert.deepEqual(planPresetApplication({ preset: "read-only", catalogNames: names }), {
      mode: "preset",
      name: "read-only",
    });
  });

  it("名字不在 catalog、但给了 sandbox+approval → 兜底事件", () => {
    const plan = planPresetApplication({
      preset: "my-narrow",
      catalogNames: names,
      fallbackSpec: { sandbox: "workspace-write", approval: "ask" },
    });
    assert.equal(plan.mode, "fallback");
    assert.deepEqual(plan.spec, { sandbox: "workspace-write", approval: "ask" });
    assert.deepEqual(fallbackSessionEvents(plan.spec), [
      { type: "approval/policy", payload: { policy: "ask" } },
      { type: "sandbox/mode", payload: { mode: "workspace-write" } },
    ]);
  });

  it("名字不认、也没有可兜底的组合 → invalid（不静默降级成默认）", () => {
    const plan = planPresetApplication({ preset: "ghost", catalogNames: names });
    assert.equal(plan.mode, "invalid");
    assert.match(plan.reason, /not-in-catalog/u);
  });

  it("回读：名字一致算成功；兜底路径按组合比对；对不上要报错", () => {
    assert.equal(
      verifyPresetApplication({ targetPreset: "read-only", currentPreset: "read-only" }).ok,
      true,
    );
    assert.equal(
      verifyPresetApplication({ targetPreset: "read-only", currentPreset: "" }).ok,
      false,
    );
    assert.equal(
      verifyPresetApplication({
        targetPreset: "my-narrow",
        currentPreset: "custom",
        targetSpec: { sandbox: "read-only", approval: "ask" },
        currentSpec: { sandbox: "read-only", approval: "ask" },
      }).ok,
      true,
    );
    const mismatch = verifyPresetApplication({
      targetPreset: "read-only",
      currentPreset: "danger-full-access",
    });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.reason, /mismatch/u);
  });
});

describe("安全文案", () => {
  it("必须写明「推/合并/删除永远需要批准」且不绕过执行器", () => {
    const text = PRESET_SAFETY_NOTES.join("\n");
    assert.match(text, /推 \/ 合并 \/ 删除永远需要你/u);
    assert.match(text, /不绕过/u);
    assert.match(text, /继承宿主/u);
    assert.match(text, /allowed-once/u);
  });
});
