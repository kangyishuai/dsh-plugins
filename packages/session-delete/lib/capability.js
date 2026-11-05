// @ts-check
// 宿主能力探测。整个插件对宿主内部契约的依赖只在这里出现一次，
// 这样 DSH 升级后需要改的地方永远只有一个文件（见 docs/adr/0005）。

/** @typedef {"api" | "internal" | "minimal" | "unknown"} CapabilityTier */

/**
 * @typedef {object} Capabilities
 * @property {CapabilityTier} tier
 * @property {Record<string, boolean>} checks
 * @property {string[]} notes
 * @property {{ persistence?: any, sessions?: any, workspace?: any, storageDomain?: any, agents?: any }} services
 */

/**
 * 安全地从 ctx 上取一个服务（Cordis 用 ctx.get，测试替身可能直接挂属性）。
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
function serviceOf(ctx, name) {
  try {
    if (typeof ctx?.get === "function") return ctx.get(name);
  } catch {
    return undefined;
  }
  return ctx?.[name];
}

/** @param {any} target @param {string} key @returns {boolean} */
function callable(target, key) {
  return typeof target?.[key] === "function";
}

/**
 * 探测本插件依赖的全部宿主能力，并按四档给出结论：
 * - api：官方文档里有的一等公民能力齐全；
 * - internal：核心可用，但有依赖社区契约的部件（会降级执行并告警）；
 * - minimal：缺少 workspaceRegistry（如 headless 组合），删除仍可做，
 *   归档闸门/工作区记账等步骤跳过并在回执里标记；
 * - unknown：持久化本体缺失，破坏性操作必须拒绝。
 *
 * @param {any} ctx host 上下文。
 * @returns {Capabilities}
 */
export function probeCapabilities(ctx) {
  const persistence = serviceOf(ctx, "sessionPersistence");
  const sessions = serviceOf(ctx, "sessions");
  const workspace = serviceOf(ctx, "workspaceRegistry");
  const storageDomain = serviceOf(ctx, "storageDomain");
  const agents = serviceOf(ctx, "agents");

  const checks = {
    "persistence.stat": callable(persistence, "stat"),
    "persistence.locate": callable(persistence, "locate"),
    "persistence.list": callable(persistence, "list"),
    "event.session-stop": typeof ctx?.parallel === "function",
    "event.session-activity": typeof ctx?.waterfall === "function",
    "sessions.get": callable(sessions, "get"),
    "sessions.flush": callable(sessions, "flush"),
    "sessions.detach": callable(sessions, "detachEntered") && Boolean(sessions?.store),
    "agents.detach": callable(agents, "detachEntered") && Boolean(agents?.store),
    "workspace.archive": callable(workspace, "archiveSession"),
    "workspace.unarchive": callable(workspace, "unarchiveSession"),
    "workspace.pin": callable(workspace, "pinSession"),
    "workspace.unpin": callable(workspace, "unpinSession"),
    "workspace.list": callable(workspace, "list"),
    "storage.domain": callable(storageDomain, "get"),
  };

  const table = /** @type {Record<string, boolean>} */ (checks);
  /** @type {string[]} */
  const notes = [];
  for (const [name, ok] of Object.entries(table)) {
    if (!ok) notes.push(`missing: ${name}`);
  }

  /** @type {CapabilityTier} */
  let tier = "api";
  // 删除本身只需要持久化读取 + 文件系统；工作区/归档只是闸门与记账，
  // 缺失时降级为 minimal（跳过对应步骤并报告），不应整体禁用。
  const essential = ["persistence.stat"];
  const workspaceGate = ["workspace.archive", "workspace.unarchive"];
  const convenient = [
    "persistence.list",
    "persistence.locate",
    "storage.domain",
    "sessions.detach",
    "agents.detach",
    "event.session-stop",
    "event.session-activity",
  ];
  if (essential.some((k) => !table[k])) tier = "unknown";
  else if (workspaceGate.some((k) => !table[k])) tier = "minimal";
  else if (convenient.some((k) => !table[k])) tier = "internal";

  return {
    tier,
    checks,
    notes,
    services: { persistence, sessions, workspace, storageDomain, agents },
  };
}

/**
 * 给客户端展示的一份精简能力快照（不暴露服务对象）。
 * @param {Capabilities} caps
 * @returns {{ tier: CapabilityTier, checks: Record<string, boolean>, notes: string[] }}
 */
export function describeCapabilities(caps) {
  return { tier: caps.tier, checks: caps.checks, notes: [...caps.notes] };
}
