// @ts-check
// 顾问的第二阶段取证：它返回 `needs: [{kind:"file", ref:"path"}]`，我们把文件内容读回来再喂一次，
// 让它基于**证据**而不是猜测下结论。
//
// 为什么不是「给顾问开放工具」：宿主目前的额外调用是单次补全，工具循环需要伪造 assistant/tool 消息，
// 跨 provider 不可靠；两阶段（请求证据 → 回灌 → 复核）语义等价、协议风险为零。
//
// 安全边界（必须全部满足才读）：
// - 路径必须在**会话工作目录**之内（resolve 后做前缀比较，防 `../` 与符号链接逃逸）；
// - 单文件 ≤ 64 KiB，一次最多 5 个文件（避免把顾问调用撑爆）；
// - 只读，不列目录、不执行命令。
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** 单文件上限。 */
export const MAX_FILE_BYTES = 64 * 1024;
/** 一次最多读几个文件。 */
export const MAX_FILES = 5;

/**
 * 判断 target 是否在 root 之内（resolve + 相对路径不以 `..` 开头）。
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(root, target) {
  if (typeof root !== "string" || root === "") return false;
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(normalizedRoot, target);
  const rel = relative(normalizedRoot, normalizedTarget);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 读回顾问要的证据。
 * @param {{ root: string, needs: Array<{ kind: string, ref: string }>, maxFiles?: number, maxBytes?: number }} input
 * @returns {Promise<{ sections: Array<{ ref: string, text: string, ok: boolean }>, refused: string[] }>}
 */
export async function collectEvidence(input) {
  const root = typeof input.root === "string" ? input.root : "";
  const maxFiles = Number.isFinite(input.maxFiles) ? Number(input.maxFiles) : MAX_FILES;
  const maxBytes = Number.isFinite(input.maxBytes) ? Number(input.maxBytes) : MAX_FILE_BYTES;
  /** @type {Array<{ ref: string, text: string, ok: boolean }>} */
  const sections = [];
  /** @type {string[]} */
  const refused = [];

  const needs = Array.isArray(input.needs) ? input.needs : [];
  let used = 0;
  for (const need of needs) {
    if (used >= maxFiles) break;
    const ref = typeof need?.ref === "string" ? need.ref.trim() : "";
    const kind = String(need?.kind ?? "file").toLowerCase();
    if (ref === "") continue;
    if (kind !== "file" && kind !== "path") {
      refused.push(`${ref}（只支持 file/path）`);
      continue;
    }
    if (!isInside(root, ref)) {
      refused.push(`${ref}（不在会话工作目录内）`);
      continue;
    }
    try {
      const realRoot = await realpath(root).catch(() => resolve(root));
      // 只有 realpath 成功时才做符号链接逃逸检查；文件不存在就交给 readFile 报 ENOENT。
      const realTarget = await realpath(resolve(root, ref)).catch(() => null);
      if (realTarget !== null && !isInside(realRoot, realTarget)) {
        refused.push(`${ref}（真实路径逃出工作目录）`);
        continue;
      }
      const buffer = await readFile(realTarget ?? resolve(root, ref));
      const clipped = buffer.subarray(0, maxBytes);
      const text = clipped.toString("utf8");
      const note = buffer.length > maxBytes ? `\n…（已截断，原长 ${buffer.length} 字节）` : "";
      sections.push({ ref, text: `${text}${note}`, ok: true });
      used += 1;
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      refused.push(`${ref}（读取失败：${code ?? String(error)}）`);
    }
  }
  return { sections, refused };
}

/**
 * 把取证结果拼成第二轮的用户消息片段。
 * @param {{ sections: Array<{ ref: string, text: string }>, refused: string[] }} evidence
 * @returns {string}
 */
export function buildVerificationBlock(evidence) {
  if (evidence.sections.length === 0 && evidence.refused.length === 0) return "";
  const parts = [
    "VERIFICATION PASS. You asked for evidence; here is what the workspace actually contains.",
    "",
  ];
  for (const section of evidence.sections) {
    parts.push(`--- ${section.ref} ---`, section.text, "");
  }
  if (evidence.refused.length > 0) {
    parts.push(`Could not read: ${evidence.refused.join("; ")}`, "");
  }
  parts.push(
    "Re-check your previous advice against this evidence. Keep it only if the evidence supports it;",
    "correct anything the files contradict, and lower the severity when you cannot substantiate it.",
  );
  return parts.join("\n");
}
