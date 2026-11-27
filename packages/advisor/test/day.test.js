// @ts-check
// 本地日键的纯函数测试（复审 F2）：不在账本测试里依赖「今天」，用固定 Date 对象钉住语义。
//
// 注意：`dayKey` 用的是**宿主本地时区**。为了让断言在任何时区都成立，日期一律用
// `new Date(year, monthIndex, day, h, m)`（本地分量）构造，只断言「年月日」文本；
// 不写死某个 UTC 时刻对应的本地字符串（那会让 CI 的 TZ=UTC 与开发机的 UTC+8 结果不同）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { dayKey, dayKeyOf, dayOfEntry } from "../lib/day.js";

test("dayKey 用本地日期分量：跨日边界与夏令时切换日都落在同一天", () => {
  assert.equal(dayKey(new Date(2026, 0, 15, 0, 0, 0)), "2026-01-15");
  assert.equal(dayKey(new Date(2026, 0, 15, 23, 59, 59)), "2026-01-15");
  assert.equal(dayKey(new Date(2026, 0, 16, 0, 0, 0)), "2026-01-16");

  // 2026-03-08 与 2026-11-01 是北美夏令时切换日（不同时区切换时刻不同）。
  // 用本地分量构造：只要实现按 getFullYear/getMonth/getDate 取值，就与 DST 无关。
  assert.equal(dayKey(new Date(2026, 2, 8, 0, 30)), "2026-03-08");
  assert.equal(dayKey(new Date(2026, 2, 8, 23, 30)), "2026-03-08");
  assert.equal(dayKey(new Date(2026, 2, 9, 0, 30)), "2026-03-09");
  assert.equal(dayKey(new Date(2026, 10, 1, 1, 30)), "2026-11-01");
  assert.equal(dayKey(new Date(2026, 10, 1, 23, 30)), "2026-11-01");
});

test("dayKeyOf：ISO 时间按本地日折算，非法输入返回空串", () => {
  const iso = "2020-01-01T00:00:00.000Z";
  // 不写死字符串（依赖时区）：断言它与「同一条时间按本地日算」一致。
  assert.equal(dayKeyOf(iso), dayKey(new Date(iso)));
  assert.equal(dayKeyOf(new Date(2026, 0, 15, 12, 0)), "2026-01-15");
  for (const bad of ["", "   ", "not-a-date", null, undefined, 42, {}]) {
    assert.equal(dayKeyOf(bad), "", `dayKeyOf(${JSON.stringify(bad)})`);
  }
  assert.equal(dayKeyOf(new Date(Number.NaN)), "");
});

test("dayOfEntry：合法 day 优先；坏 day 回落到 at 的本地日；两者都缺返回空串", () => {
  assert.equal(dayOfEntry({ day: "2026-11-28", at: "2020-01-01T00:00:00.000Z" }), "2026-11-28");
  // 畸形 day（形状不对）不能当权威值用，否则会让某个坏行永久记到错误日期。
  const at = "2026-11-28T12:00:00.000Z";
  for (const badDay of ["2026-1-1", "2026/11/28", "", 20261128, null]) {
    assert.equal(
      dayOfEntry({ day: badDay, at }),
      dayKey(new Date(at)),
      `day=${JSON.stringify(badDay)} 应回落到 at`,
    );
  }
  assert.equal(dayOfEntry({}), "");
  assert.equal(dayOfEntry(undefined), "");
  assert.equal(dayOfEntry({ at: "not-a-date" }), "");
});
