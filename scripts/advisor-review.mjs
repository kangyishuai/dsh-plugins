#!/usr/bin/env node
// @ts-check
// 顾问决策复盘：读 `<dataRoot>/advisor/decisions.jsonl`，回答两个问题——
//   1) 该徵询的回合有没有徵询（漏徵询）；
//   2) 徵询了之后建议有没有被采纳（过度徵询 / 无效徵询）。
//
// 只读本地文件，不联网、不调用模型。数据攒够几天再据此调触发策略，
// 而不是拍脑袋定「每 N 轮问一次」。
//
// 用法：
//   pnpm advisor:review                  # 默认读 ~/.dsh
//   pnpm advisor:review --home /path     # 指定数据根（临时 home 调试用）
//   pnpm advisor:review --days 7         # 只看最近 7 天
//   pnpm advisor:review --json           # 输出 JSON，便于二次处理
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
/** @param {string} flag @returns {string|undefined} */
const flagValue = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

const home = flagValue("--home") ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
const daysRaw = flagValue("--days");
const days = daysRaw === undefined ? undefined : Number(daysRaw);
const asJson = args.includes("--json");
const path = join(home, "advisor", "decisions.jsonl");

/**
 * 读决策日志；坏行跳过。
 * @param {string} file
 * @returns {Promise<any[]>}
 */
async function readRecords(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  /** @type {any[]} */
  const out = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch (_error) {
      /* 跳过坏行 */
    }
  }
  return out;
}

// 复盘逻辑与插件内 keep 同一份实现，避免两处口径漂移。
import { fileURLToPath } from "node:url";

const { summarize, bucketOf } = await import(
  fileURLToPath(new URL("../packages/advisor/lib/decisions.js", import.meta.url))
);

let records = await readRecords(path);
if (records.length === 0) {
  console.log(`没有决策日志：${path}`);
  console.log("提示：日志由 advisor 插件在宿主侧自动写入，先正常用一段时间再回来复盘。");
  process.exit(0);
}

const dayWindow = typeof days === "number" && Number.isFinite(days) && days > 0 ? days : 0;
if (dayWindow > 0) {
  const since = Date.now() - dayWindow * 24 * 60 * 60 * 1000;
  records = records.filter((record) => {
    const at = Date.parse(String(record?.at ?? ""));
    return Number.isFinite(at) && at >= since;
  });
}

const stats = summarize(records);

if (asJson) {
  console.log(JSON.stringify({ home, path, days: days ?? null, ...stats }, null, 2));
  process.exit(0);
}

/** @param {number|null} value @returns {string} */
const pct = (value) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
/** @param {any} record @returns {string} */
const when = (record) =>
  String(record?.at ?? "")
    .replace("T", " ")
    .slice(0, 19);

console.log(`决策日志：${path}`);
console.log(`回合：${stats.turns} · 徵询：${stats.consulted}（${pct(stats.consultRate)}）`);
console.log(
  `采纳：${stats.accepted} · 另打字：${stats.ignored} · 无动作：${stats.noAction} · 采纳率：${pct(stats.acceptRate)}`,
);

console.log("\n按分桶（长/短回答 × 有无工具 × 有无报错）");
console.log("分桶                    回合  徵询  采纳  另打字  无动作");
for (const bucket of stats.buckets) {
  const label = String(bucket.bucket).padEnd(20, " ");
  console.log(
    `${label} ${String(bucket.turns).padStart(4)} ${String(bucket.consulted).padStart(5)} ${String(
      bucket.accepted,
    ).padStart(5)} ${String(bucket.ignored).padStart(7)} ${String(bucket.noAction).padStart(6)}`,
  );
}

const skipEntries = Object.entries(stats.skipCodes ?? {}).sort(
  (a, b) => Number(b[1]) - Number(a[1]),
);
if (skipEntries.length > 0) {
  console.log("\n未徵询的原因");
  for (const [code, count] of skipEntries) {
    console.log(`  ${String(code).padEnd(28, " ")} ${count}`);
  }
}

if (stats.missed.length > 0) {
  console.log("\n疑似漏徵询（有工具 + 长回答 + 无报错，但没徵询）");
  for (const record of stats.missed) {
    console.log(
      `  ${when(record)}  ${bucketOf(record)}  回答 ${record.answerChars} 字 · ${record.skipCode}`,
    );
  }
}

if (stats.overConsulted.length > 0) {
  console.log("\n疑似无效徵询（徵询了，但用户随后自己发了别的内容）");
  for (const record of stats.overConsulted) {
    console.log(
      `  ${when(record)}  ${record.severity ?? "-"} · ${record.trigger ?? "-"} · ${bucketOf(record)}`,
    );
  }
}

console.log(
  "\n判读方法：漏徵询占比高 → 触发条件太严（放宽工具/长度门槛）；" +
    "无效徵询占比高 → 触发条件太松（加上「有工具且回答够长」之外的判据）。",
);
