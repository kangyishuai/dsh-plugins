// @ts-check
// gate 的断言计数解析：用来识别「脚本退出码 0 但一条断言都没跑」的假绿。
// 背景：agent 在自己的会话里跑桌面回归时，可见会话有运行中的回合，脚本按设计 SKIP，
// 退出码仍是 0。门禁头部写着「不能没跑还说通过」，这里把那条承诺变成可测的判定。
import assert from "node:assert/strict";
import test from "node:test";

import { desktopGateVerdict, gateVerdict, isVacuousPass, parseCounts } from "../gate.mjs";

test("parseCounts：解析标准收尾行", () => {
  assert.deepEqual(parseCounts("7 PASS / 3 SKIP / 0 FAIL（默认，未发起模型调用）"), {
    pass: 7,
    skip: 3,
    fail: 0,
  });
  assert.deepEqual(parseCounts("0 PASS / 1 SKIP / 0 FAIL"), { pass: 0, skip: 1, fail: 0 });
  assert.deepEqual(parseCounts("4 PASS / 2 SKIP / 1 FAIL"), { pass: 4, skip: 2, fail: 1 });
});

test("parseCounts：取**最后**一条，前面的中间统计不算", () => {
  const output = [
    "PASS 页面可交互",
    "1 PASS / 0 SKIP / 0 FAIL",
    "PASS 浮层可打开",
    "7 PASS / 3 SKIP / 0 FAIL（--deep）",
    "PASS history 文件已生成",
  ].join("\n");
  assert.deepEqual(parseCounts(output), { pass: 7, skip: 3, fail: 0 });
});

test("parseCounts：剥掉 ANSI 颜色码", () => {
  const output =
    "\u001B[32m7 PASS\u001B[0m / \u001B[33m3 SKIP\u001B[0m / \u001B[32m0 FAIL\u001B[0m";
  assert.deepEqual(parseCounts(output), { pass: 7, skip: 3, fail: 0 });
});

test("parseCounts：多余空白也认", () => {
  assert.deepEqual(parseCounts("  7  PASS  /  3  SKIP  /  0  FAIL  "), {
    pass: 7,
    skip: 3,
    fail: 0,
  });
});

test("parseCounts：没有计数行返回 undefined", () => {
  assert.equal(parseCounts(""), undefined);
  assert.equal(parseCounts("SKIP 桌面交互 — 当前会话有运行中的回合"), undefined);
  assert.equal(parseCounts(undefined), undefined);
  assert.equal(parseCounts(null), undefined);
});

test("desktopGateVerdict：缺计数行判失败（2026-11-20 补的洞）", () => {
  // 没有计数行时 isVacuousPass 返回 false，旧门禁会直接放行——这就是那个洞。
  assert.equal(isVacuousPass(undefined), false);
  assert.equal(desktopGateVerdict(undefined), "missing-counts");
});

test("desktopGateVerdict：全 SKIP 判假绿，跑过断言才放行", () => {
  assert.equal(desktopGateVerdict({ pass: 0, skip: 1, fail: 0 }), "vacuous");
  assert.equal(desktopGateVerdict({ pass: 0, skip: 5, fail: 0 }), "vacuous");
  assert.equal(desktopGateVerdict({ pass: 4, skip: 2, fail: 0 }), "ok");
  assert.equal(desktopGateVerdict({ pass: 0, skip: 0, fail: 1 }), "ok", "失败交给退出码处理");
  assert.equal(desktopGateVerdict(parseCounts("16 PASS / 2 SKIP / 0 FAIL")), "ok");
});

test("gateVerdict：web 与桌面共用同一套判定（2026-11-20 起 web 也打印计数行）", () => {
  assert.equal(gateVerdict(undefined), "missing-counts");
  assert.equal(gateVerdict({ pass: 0, skip: 4, fail: 0 }), "vacuous");
  assert.equal(gateVerdict({ pass: 15, skip: 3, fail: 0 }), "ok");
  assert.equal(gateVerdict(parseCounts("33 PASS / 0 SKIP / 0 FAIL")), "ok");
  assert.equal(gateVerdict, desktopGateVerdict, "别名必须指向同一个实现");
});

test("isVacuousPass：全 SKIP 判为假绿，跑过断言不算", () => {
  assert.equal(isVacuousPass({ pass: 0, skip: 1, fail: 0 }), true, "0 通过 0 失败 = 什么都没验证");
  assert.equal(isVacuousPass({ pass: 0, skip: 5, fail: 0 }), true);
  assert.equal(isVacuousPass({ pass: 4, skip: 2, fail: 0 }), false, "有通过就不是假绿");
  assert.equal(isVacuousPass({ pass: 0, skip: 0, fail: 1 }), false, "失败交给退出码处理");
  assert.equal(isVacuousPass(undefined), false, "解析不到计数就不下判断");
});
