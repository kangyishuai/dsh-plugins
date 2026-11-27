// @ts-check
// 面板写路径的「核心」：发一句话 / steering / 换模型 / 开 PR。
//
// 为什么抽出来（B2 复审 P1-6）：这四条原来直接长在 service 上，而 service 顶部 import 了
// 宿主包（仓库里没有），node --test 里 import 不了 → 参数形状（`mode:'steer'`、
// `content:[{type:'text'}]`、`reasoningEffort`）和「signal 必传」全部没有单测。
// 这里把「怎么拼参数、怎么回读、写什么审计」放在纯模块里，service 只负责把真实依赖接上，
// 单测用假 sessionController 就能把形状钉住。

/**
 * 协调者气泡去重（B2 复审 P2）：面板发送时乐观写一条 `user` 发言，宿主随后又发
 * `user/message` 事件，两条内容相同 —— 不去重就会看到两个一样的气泡。
 * 规则：同 role、同文本（忽略首尾空白）、且与最后一条的时间差在窗口内 → 判为重复。
 * @param {Array<{role: string, text: string, at: number}>} list
 * @param {"assistant"|"user"} role @param {string} text @param {number} at
 * @param {number} [windowMs]
 * @returns {boolean} 是否应该写入
 */
export function shouldRecordCoordinatorMessage(list, role, text, at, windowMs = 5000) {
  const body = String(text ?? "").trim();
  if (body === "") return false;
  const last = Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
  if (!last) return true;
  if (String(last.role) !== role) return true;
  if (String(last.text ?? "").trim() !== body) return true;
  const gap = Math.abs(Number(at) - Number(last.at));
  return !(Number.isFinite(gap) && gap <= windowMs);
}

/**
 * 给协调器投递消息的参数（F9）。`requestId` 由调用方给，便于测试确定性。
 * @param {string} sessionId @param {string} text @param {number} at
 * @returns {{ requestId: string, sessionId: string, mode: "queue", content: Array<{ type: "text", text: string }> }}
 */
export function coordinatorPromptParams(sessionId, text, at) {
  return {
    requestId: `projects-coordinator-msg-${at}`,
    sessionId,
    mode: "queue",
    content: [{ type: "text", text }],
  };
}

/**
 * 线程 steering 的参数（F19）：`mode:'steer'`（探针验证过的写法）。
 * @param {string} sessionId @param {string} text @param {number} at
 * @returns {{ requestId: string, sessionId: string, mode: "steer", content: Array<{ type: "text", text: string }> }}
 */
export function steerPromptParams(sessionId, text, at) {
  return {
    requestId: `projects-steer-${at}`,
    sessionId,
    mode: "steer",
    content: [{ type: "text", text }],
  };
}

/**
 * 换模型参数（F24/F42）：effort 为空串时**不带**该字段（继承宿主默认）。
 * @param {string} sessionId @param {string} provider @param {string} model @param {string} [effort]
 * @returns {{ sessionId: string, provider: string, model: string, reasoningEffort?: string }}
 */
export function selectModelParams(sessionId, provider, model, effort) {
  /** @type {{ sessionId: string, provider: string, model: string, reasoningEffort?: string }} */
  const params = { sessionId, provider, model };
  const trimmed = String(effort ?? "").trim();
  if (trimmed !== "") params.reasoningEffort = trimmed;
  return params;
}

/**
 * 发一句话给协调器（没有会话就先建）。
 * @param {object} deps
 * @param {any} deps.store
 * @param {any} deps.sessionController
 * @param {(projectId: string) => Promise<{ sessionId: string, created?: boolean }>} deps.ensureCoordinator
 * @param {(projectId: string, role: "user"|"assistant", text: string) => void} [deps.recordMessage]
 * @param {string} deps.projectId @param {string} deps.text
 * @param {() => number} [deps.now]
 */
export async function sendToCoordinatorCore(deps) {
  const project = deps.store.getProject(deps.projectId);
  if (!project) throw new Error(`projects: unknown project ${deps.projectId}`);
  const input = String(deps.text ?? "").trim();
  if (input === "") throw new Error("projects: coordinator message requires text");
  const created = await deps.ensureCoordinator(deps.projectId);
  const sessionId = String(created.sessionId);
  const sc = deps.sessionController;
  if (!sc) throw new Error("projects: session controller unavailable");
  const at = typeof deps.now === "function" ? deps.now() : Date.now();
  // signal 必传：宿主 prompt 在 signal 缺失时会抛（真机踩过），这里固定给一个新的
  await sc.prompt(coordinatorPromptParams(sessionId, input, at), new AbortController().signal);
  deps.recordMessage?.(deps.projectId, "user", input);
  deps.store.appendAudit({
    action: "coordinator/message",
    projectId: deps.projectId,
    sessionId,
    created: created.created === true,
  });
  deps.store.save();
  return { sessionId, sent: true, created: created.created === true, chars: input.length };
}

/**
 * 线程 steering（F19）。
 * @param {object} deps
 * @param {any} deps.store @param {any} deps.sessionController
 * @param {string} deps.sessionId @param {string} deps.text
 * @param {() => number} [deps.now]
 */
export async function steerThreadCore(deps) {
  const project = deps.store.projectOfSession(deps.sessionId);
  if (!project) throw new Error(`projects: unknown thread ${deps.sessionId}`);
  const input = String(deps.text ?? "").trim();
  if (input === "") throw new Error("projects: steer requires text");
  const sc = deps.sessionController;
  if (!sc) throw new Error("projects: session controller unavailable");
  /** @type {any} */
  let live = null;
  try {
    live = await sc.state({ sessionId: deps.sessionId }, AbortSignal.timeout(1500));
  } catch {
    live = null;
  }
  const at = typeof deps.now === "function" ? deps.now() : Date.now();
  await sc.prompt(steerPromptParams(deps.sessionId, input, at), new AbortController().signal);
  deps.store.appendAudit({
    action: "thread/steer",
    projectId: project.id,
    sessionId: deps.sessionId,
    chars: input.length,
  });
  deps.store.save();
  return { steered: true, running: live?.running === true, chars: input.length };
}

/**
 * 换模型 / effort（F24/F42），改完**回读** `modelSelection`，不假装开关生效。
 * @param {object} deps
 * @param {any} deps.store @param {any} deps.sessionController
 * @param {string} deps.projectId @param {string} deps.sessionId
 * @param {{ provider?: string, model?: string, reasoningEffort?: string }} deps.input
 */
export async function selectThreadModelCore(deps) {
  const project = deps.store.getProject(deps.projectId);
  if (!project) throw new Error(`projects: unknown project ${deps.projectId}`);
  const thread = deps.store
    .listThreads(deps.projectId)
    .find((/** @type {any} */ item) => item.sessionId === deps.sessionId);
  if (!thread) throw new Error(`projects: unknown thread ${deps.sessionId}`);
  const provider = String(deps.input?.provider ?? "").trim();
  const model = String(deps.input?.model ?? "").trim();
  if (provider === "" || model === "") throw new Error("projects: provider and model required");
  const sc = deps.sessionController;
  if (!sc || typeof sc.selectModel !== "function") {
    throw new Error("projects: session controller unavailable");
  }
  const effort = String(deps.input?.reasoningEffort ?? "").trim();
  await sc.selectModel(
    selectModelParams(deps.sessionId, provider, model, effort),
    new AbortController().signal,
  );
  /** @type {any} */
  let selection = null;
  try {
    await sc.state({ sessionId: deps.sessionId }, AbortSignal.timeout(1500));
    const value =
      typeof sc.projections === "function"
        ? await sc.projections({ sessionId: deps.sessionId }, AbortSignal.timeout(1500))
        : null;
    selection = value?.modelSelection ?? null;
  } catch {
    selection = null;
  }
  deps.store.appendAudit({
    action: "thread/model",
    projectId: deps.projectId,
    sessionId: deps.sessionId,
    provider,
    model,
    reasoningEffort: effort || null,
  });
  deps.store.save();
  return {
    ok: true,
    sessionId: deps.sessionId,
    provider,
    model,
    reasoningEffort: effort || null,
    selection,
  };
}

/**
 * Create PR 按钮入口（F12/F20）：走既有 `openPr`，并回读线程的 PR/分支状态。
 * **必须**把「为什么没开」透出来（`reason`）：以前只有 `decision.reason`，UI 显示 "?"。
 * @param {object} deps
 * @param {any} deps.store
 * @param {(projectId: string, sessionId: string, options: any) => Promise<any>} deps.openPr
 * @param {string} deps.projectId @param {string} deps.sessionId
 * @param {{ tier?: string, base?: string, repo?: string }} [deps.options]
 */
export async function createPrCore(deps) {
  const project = deps.store.getProject(deps.projectId);
  if (!project) throw new Error(`projects: unknown project ${deps.projectId}`);
  const tier = String(deps.options?.tier ?? project.policy?.pr?.tier ?? "draft");
  const result = await deps.openPr(deps.projectId, deps.sessionId, {
    ...(deps.options ?? {}),
    tier,
  });
  const thread = deps.store
    .listThreads(deps.projectId)
    .find((/** @type {any} */ item) => item.sessionId === deps.sessionId);
  return {
    ...(result ?? {}),
    // F20：决策路径（tier-off / no-commits / …）只把原因放在 decision 里，UI 要能直说
    reason: String(result?.reason ?? result?.decision?.reason ?? "unknown"),
    tier,
    branch: thread?.branch ?? null,
    prNumber: thread?.prNumber ?? result?.prNumber ?? null,
    ciState: thread?.ciState ?? null,
  };
}
