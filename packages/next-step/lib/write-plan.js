// @ts-check
// 一次**成功**的生成结算成什么样：要不要显示、事件里的 gate 写哪个值。
//
// 为什么单独一个纯函数（AUD-NS-01）：`shown` 是写卡时冻结的展示标记，三种输入共同决定它——
// 用户档位（`shouldShow`）、手动补生成（`force`）、以及这次生成是不是已经被更新的回合取代
// （`superseded`）。这三种组合以前散在 service.js 的一个三元表达式里，没法单测；而「superseded
// 优先于 force」正是「下一轮开始后不再丢 token、也不把过期卡塞回对话流」的关键口径。
//
// gate 是事件里的闸门分类：`ok` 表示正常出卡/被档位抑制；`superseded` 表示生成跑完了但这一轮
// 已经翻过去了，候选以 `shown:false` 落库（报表的「闸门分布」里能直接看到这一类的量）。

import { shouldShow } from "./scheme.js";

/**
 * @param {{ value: unknown, tier: unknown, force?: boolean, superseded?: boolean }} input
 * @returns {{ shown: boolean, gate: "ok" | "superseded" }}
 */
export function planCardWrite(input) {
  // 已经翻过去的回合：卡片属于历史轮次，显示出来只会变成「旧卡」噪音。
  // 优先级高于 force——手动补生成期间用户又开始下一轮，说明这张卡已经不重要了。
  if (input.superseded === true) return { shown: false, gate: "superseded" };
  const shown = input.force === true ? true : shouldShow(input.value, input.tier);
  return { shown, gate: "ok" };
}
