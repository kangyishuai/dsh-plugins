// @ts-check
// host 半：在 DSH 的 Node 进程里运行，可以使用 ctx 上的宿主服务。
// 改动后需要重启 DSH 桌面版。

export const name = "__NAME__";

/**
 * @param {DSH.HostContext} ctx
 * @param {Record<string, unknown>} [_config]
 */
export function apply(ctx, _config) {
  ctx.logger.info(`[${name}] loaded`);
}
