// @ts-check
// Web 路由：GET /artifacts/<id>[?v=N][&download=1] 返回某个版本。
//
// 安全边界（DSH 宿主没有兜底 CSP，全部由这里自己焊）：
//   - 只认 GET / HEAD；
//   - 先过 ctx.connection.requestRejection（未认证的请求直接 401/403）；
//   - html 带严格 CSP；其它类型给 `nosniff` + 与类型匹配的 Content-Type；
//   - frame-ancestors 'self'：只允许 DSH 自己的页面嵌（外部站点不能套）；
//   - no-store：版本随时变，不缓存。
//
// 0.2 起按 meta.kind 决定 Content-Type：文本类型按 UTF-8 送出，图片送**原始字节**
// （不能先转字符串，否则 PNG/JPEG 会被破坏）。markdown / csv 刻意用 text/plain 送，
// 因为浏览器的 text/markdown、text/csv 顶层导航会变成下载，而不是预览。
import { createCoverSvg } from "./cover.js";
import { isSafeArtifactId } from "./store.js";

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

/** 图片/CSP 沙箱：SVG 是"能带脚本的图片"，必须连同源能力一起掐掉。 */
const MEDIA_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

/**
 * kind → 实际送出的 Content-Type。
 * @param {{ kind: string, mime: string }} found
 * @returns {string}
 */
export function contentTypeFor(found) {
  if (found.kind === "image") return found.mime;
  if (found.kind === "json") return "application/json; charset=utf-8";
  if (found.kind === "markdown" || found.kind === "csv") return "text/plain; charset=utf-8";
  return "text/html; charset=utf-8";
}

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
      const segments = rest.split("/");
      const id = decodeURIComponent(segments[0] ?? "");
      const sub = segments[1] ?? "";
      if (id === "" || segments.length > 2) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      // `%2F` / `%5C` 解码后会带出路径分隔符：这类 id 一律 400，绝不进文件系统。
      if (!isSafeArtifactId(id)) {
        res.statusCode = 400;
        res.end("bad artifact id");
        return;
      }
      // 封面：GET /artifacts/<id>/cover.svg —— 纯 SVG，不需要 headless 渲染器。
      if (sub === "cover.svg") {
        const target = await store.read(id);
        if (target === undefined) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const svg = createCoverSvg({
          id,
          title: target.meta.title,
          html: target.text,
          kind: target.kind,
        });
        res.statusCode = 200;
        res.setHeader("content-type", "image/svg+xml; charset=utf-8");
        res.setHeader(
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        );
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("cache-control", "private, no-cache");
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        res.end(svg);
        return;
      }
      if (sub !== "") {
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
      const contentType = contentTypeFor(found);
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("cache-control", "private, no-store");
      res.setHeader("x-artifact-kind", found.kind);
      res.setHeader("x-artifact-version", String(found.version));
      if (found.kind === "html") {
        res.setHeader("content-security-policy", CSP);
      } else if (found.kind === "image") {
        res.setHeader("content-security-policy", MEDIA_CSP);
      }
      if (url.searchParams.get("download") === "1") {
        const name = `${id}.v${found.version}.${found.ext}`;
        res.setHeader("content-disposition", `attachment; filename="${encodeURIComponent(name)}"`);
      }
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      // 文本送字符串，图片送原始字节：Node 的 res.end 两种都吃，测试里的假 res 也按原样记录。
      res.end(found.kind === "image" ? found.data : found.text);
    } catch (error) {
      console.error("[artifacts] route failed:", error);
      res.statusCode = 500;
      res.end(`route error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
