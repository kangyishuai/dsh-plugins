// @ts-check
// 回溯前把运行中的回合停下来：取消（保留 inbox）→ 等 idle → 丢弃尚未投递的 steering。
// 纯逻辑 + 注入 wait，便于用假 agent 单测；不 import 任何宿主包。
//
// DSH 0.2.2-rc.1 的 Agent 形状：
//   - agent.status: "idle" | "running"
//   - agent.cancel(cause, { keepInbox })：keepInbox 时不清空队列
//   - agent.whenIdle(): Promise<void>（回合结束后 resolve）
//   - agent.inbox.nextStep: 待投递的插话消息；agent.inbox.remove(id)

/** 默认等待 idle 的超时（毫秒）。 */
export const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;

/**
 * @typedef {object} SettleResult
 * @property {boolean} cancelled 是否发起过取消
 * @property {boolean} idle 是否最终空闲
 * @property {string[]} droppedSteering 丢弃的插话消息 id
 */

/**
 * 等待 agent 空闲；优先用宿主提供的 whenIdle，否则轮询 status。
 * @param {any} agent
 * @param {number} timeoutMs
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<boolean>}
 */
async function waitForIdle(agent, timeoutMs, sleep) {
  const timeout = new Promise((resolve) => {
    void sleep(timeoutMs).then(() => resolve(false));
  });
  if (typeof agent?.whenIdle === "function") {
    try {
      const idle = Promise.resolve(agent.whenIdle()).then(
        () => true,
        () => false,
      );
      return await Promise.race([idle, timeout]);
    } catch (_error) {
      return false;
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (agent?.status === "idle") return true;
    await sleep(100);
  }
  return agent?.status === "idle";
}

/**
 * 丢弃 next-step（尚未投递的插话）消息。
 * @param {any} agent
 * @returns {string[]}
 */
function dropPendingSteering(agent) {
  /** @type {string[]} */
  const dropped = [];
  try {
    const pending = agent?.inbox?.nextStep;
    if (!pending || typeof agent?.inbox?.remove !== "function") return dropped;
    for (const message of [...pending]) {
      if (message && typeof message.id === "string" && message.id !== "") {
        try {
          agent.inbox.remove(message.id);
          dropped.push(message.id);
        } catch (_error) {
          /* 单条失败不影响其余 */
        }
      }
    }
  } catch (_error) {
    /* inbox 形状不符时放弃丢弃 */
  }
  return dropped;
}

/**
 * 停下运行中的回合并等待空闲。已经空闲时是 no-op。
 * @param {any} agent
 * @param {{timeoutMs?: number, sleep?: (ms: number) => Promise<void>}} [options]
 * @returns {Promise<SettleResult>}
 */
export async function settleAgent(agent, options = {}) {
  if (!agent || agent.status === "idle")
    return { cancelled: false, idle: true, droppedSteering: [] };
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_CANCEL_TIMEOUT_MS;
  const sleep =
    typeof options.sleep === "function"
      ? options.sleep
      : (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    if (typeof agent.cancel === "function") agent.cancel({ kind: "user" }, { keepInbox: true });
  } catch (_error) {
    /* 取消失败时仍尝试等待 idle；超时会交给调用方报错 */
  }
  const idle = await waitForIdle(agent, timeoutMs, sleep);
  return {
    cancelled: true,
    idle,
    droppedSteering: idle ? dropPendingSteering(agent) : [],
  };
}
