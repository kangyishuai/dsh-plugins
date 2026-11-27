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
import { ArtifactError, isSafeArtifactId } from "./store.js";

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
      // 畸形百分号编码（`/%`、`/%E0%A4%A`）会让 decodeURIComponent 抛 URIError：
      // 这是调用方的 URL 错误，语义是 400，不能落到外层兜底变成 500 并漏出内部错误文本（AUD-ARTIFACTS-04）。
      /** @type {string} */
      let id;
      try {
        id = decodeURIComponent(segments[0] ?? "");
      } catch {
        res.statusCode = 400;
        res.end("bad artifact id");
        return;
      }
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
      // `?v=` 存在但不是正整数 → 400（AUD-ARTIFACTS-05）：静默回落最新版会让调用方
      // 以为拿到了指定版本，排查时误判；这是 URL 参数错误，不是 404。
      const wanted = url.searchParams.get("v");
      /** @type {number | undefined} */
      let version;
      if (wanted !== null) {
        if (!/^[1-9][0-9]*$/u.test(wanted)) {
          res.statusCode = 400;
          res.end("bad version");
          return;
        }
        version = Number(wanted);
        if (!Number.isSafeInteger(version)) {
          res.statusCode = 400;
          res.end("bad version");
          return;
        }
      }
      const found = await store.read(id, version);
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
      // 版本字节与 meta 声明不符：明确告诉调用方"这一版坏了"，绝不把坏正文当正常版本送出
      // （AUD-ARTIFACTS-02）。错误码仍是契约里的 artifacts/failed，细分原因是 reason。
      if (error instanceof ArtifactError && error.reason === "corrupt-version") {
        res.end("artifact version corrupted");
        return;
      }
      // 其它内部错误只给通用文案：不要把文件路径/系统错误文本（AUD-ARTIFACTS-04）漏给调用方。
      res.end("internal error");
    }
  };
}
