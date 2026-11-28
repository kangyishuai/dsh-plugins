// @ts-check
// `--deep` 删除文件段的判定边界。
//
// 三种情形必须分开，混在一起会把「工具调了但没删掉」伪装成环境分支：
// - run  ：确实调了 `apply_patch` 且文件真的消失 → 继续断言「确认框预览 / 回溯重建」；
// - fail ：调了 `apply_patch` 但文件还在 → **真失败**，不是宿主能力问题（不能记 SKIP）；
// - skip ：压根没调 `apply_patch`（宿主未注册该工具、或模型改用 bash）→ 环境分支，SKIP 并写理由。
//
// 抽出纯函数是为了可测：脚本是端到端 e2e，CI 里无法稳定制造「调了 apply_patch 但没删掉」，
// 所以用单测锁住这条边界（scripts/test/deep-delete-gate.test.js，mutation 见提交说明）。

/** @typedef {"run" | "fail" | "skip"} DeepDeleteVerdict */

/**
 * @param {{ usedApplyPatch: boolean, deleted: boolean }} facts
 * @returns {DeepDeleteVerdict}
 */
export function deepDeleteVerdict(facts) {
  if (!facts.usedApplyPatch) return "skip";
  return facts.deleted ? "run" : "fail";
}
