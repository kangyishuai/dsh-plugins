// @ts-check
// auto-fix 循环：轮数上限、无进展即停、不碰测试断言。纯函数、零 I/O。
// 依据 ADR 0003 与 m4-design.md §3：只在本地 worktree 产出提交，**不 push、不开 PR**。

/** 默认最多修几轮。 */
export const MAX_FIX_ROUNDS = 3;

/** 测试相关文件的判定（修复里碰到它们就停，防止"改测试让它绿"）。 */
const TEST_FILE_PATTERNS = [
  /(^|\/)test\//u,
  /\.test\.[cm]?[jt]sx?$/u,
  /\.spec\.[cm]?[jt]sx?$/u,
  /(^|\/)__tests__\//u,
  /(^|\/)tests?\//u,
  /(^|\/)testdata\//u,
  /(^|\/)fixtures?\//u,
];

/**
 * 把 CI 日志压成稳定的"错误签名"，用来判断「是不是同一个错」。
 * 去掉时间戳、行号、耗时、随机 id，避免同一错误因噪声被判成新错误。
 * @param {string} logText
 * @param {number} [maxLines]
 * @returns {string}
 */
export function errorSignature(logText, maxLines = 8) {
  const lines = String(logText ?? "")
    .split("\n")
    .map((line) =>
      line
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/gu, "<ts>")
        .replace(/\b\d+(\.\d+)?\s?(ms|s|m)\b/gu, "<dur>")
        .replace(/:\d+:\d+/gu, ":<loc>")
        .replace(/\b[0-9a-f]{7,40}\b/gu, "<sha>")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .filter((line) => /error|fail|expected|received|cannot|not found|undefined/iu.test(line));
  const picked = lines.slice(0, maxLines);
  return picked.join("\n").slice(0, 1200);
}

/**
 * 修复是否碰到了测试文件。
 * @param {string[]} changedFiles
 * @returns {string[]} 命中的文件
 */
export function touchedTestFiles(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  return files.filter((file) => TEST_FILE_PATTERNS.some((pattern) => pattern.test(String(file))));
}

/**
 * 判断还要不要继续修。
 * @param {object} input
 * @param {number} input.round 已经修了几轮
 * @param {number} [input.maxRounds]
 * @param {string[]} [input.changedFiles] 上一轮的改动文件（用于"无进展"与"碰测试"判断）
 * @param {string} [input.previousSignature]
 * @param {string} [input.currentSignature]
 * @param {boolean} [input.sameSignatureTwice]
 * @returns {{ continue: boolean, reason: string }}
 */
export function shouldContinueFix(input) {
  const round = Number.isFinite(input?.round) ? Number(input.round) : 0;
  const maxRounds = Number.isFinite(input?.maxRounds) ? Number(input.maxRounds) : MAX_FIX_ROUNDS;

  if (round >= maxRounds) return { continue: false, reason: "max-rounds" };

  const changed = Array.isArray(input?.changedFiles) ? input.changedFiles : [];

  // 顺序有讲究：同样是「该停」，但要给出**最可操作**的原因。
  // 「同一个错还在」比「没有改动」更能说明问题，所以先判它。
  const tests = touchedTestFiles(changed);
  if (tests.length > 0) return { continue: false, reason: "test-touched" };

  if (input?.sameSignatureTwice === true) return { continue: false, reason: "same-error-twice" };

  const previous = String(input?.previousSignature ?? "");
  const current = String(input?.currentSignature ?? "");
  if (round > 0 && previous !== "" && current !== "" && previous === current) {
    return { continue: false, reason: "same-error-twice" };
  }

  if (round > 0 && changed.length === 0) return { continue: false, reason: "no-progress" };

  return { continue: true, reason: "" };
}

/**
 * 生成下一轮修复任务的提示词（明确禁区，避免模型自作主张）。
 * @param {{ round: number, signature: string, projectName?: string }} input
 * @returns {string}
 */
export function buildFixTask(input) {
  const round = Number.isFinite(input?.round) ? Number(input.round) + 1 : 1;
  const signature = String(input?.signature ?? "").trim();
  return [
    `修复 CI 失败（第 ${round} 轮）。`,
    "",
    "错误摘要：",
    "```",
    signature === "" ? "(没抓到明确的错误行，先自己复现)" : signature,
    "```",
    "",
    "约束（必须遵守）：",
    "- 只改产品代码，**不要修改测试文件或断言**；如果修复必须先改测试，停下来说明原因。",
    "- 不要 push、不要开 PR、不要改版本号。",
    "- 改完在本地提交一次，提交信息写清修的是什么。",
  ].join("\n");
}
