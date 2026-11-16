// @ts-check
// Web 路由：GET /artifacts/<id>[?v=N] 返回某个版本的自包含页面。
//
// 安全边界（DSH 宿主没有兜底 CSP，全部由这里自己焊）：
//   - 只认 GET / HEAD；
//   - 先过 ctx.connection.requestRejection（未认证的请求直接 401/403）；
//   - 响应头带 CSP：页面不允许外链与脚本（spike 阶段只服务静态页）；
//   - frame-ancestors 'self'：只允许 DSH 自己的页面嵌（外部站点不能套）；
//   - no-store：版本随时变，不缓存。

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "script-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/**
 * @param {{ store: any, connection: () => any, basePath?: string }} deps
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createRouteHandler({ store, connection }) {
  return async (req, res) => {
    try {
      const rejection = connection()?.requestRejection?.(req);
      if (typeof rejection === "number") {
        res.statusCode = rejection;
        res.end();
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("allow", "GET, HEAD");
        res.end();
        return;
      }
      const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
      const prefix = "/artifacts/";
      const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
      const id = decodeURIComponent(rest);
      if (id === "" || id.includes("/")) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const wanted = url.searchParams.get("v");
      const version = wanted === null ? undefined : Number(wanted);
      const found = await store.read(id, Number.isInteger(version) ? version : undefined);
      if (found === undefined) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-security-policy", CSP);
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("cache-control", "private, no-store");
      res.setHeader("x-artifact-version", String(found.version));
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(found.html);
    } catch (error) {
      console.error("[artifacts] route failed:", error);
      res.statusCode = 500;
      res.end(`route error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
