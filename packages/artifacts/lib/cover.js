// @ts-check
// 封面生成：不引入任何 headless 渲染器，直接从元数据合成一张 SVG 封面。
//
// 为什么这么做（见 notes/artifacts/replication-gaps-and-differentiation.md §6.1）：
//   - Claude 的服务端截图方案在本地没有等价物（宿主不带 headless Chromium）；
//   - 自带 Chromium 等于把 issue #79448 那种「预览进程 GB/小时泄漏」搬进来；
//   - 列表需要的是"能一眼区分"的缩略图，不是像素级截图——标题 + 主题色 + 首屏结构足够。
//
// 输出是纯字符串：同一份元数据永远得到同一张 SVG（可按 sha256 缓存）。

const WIDTH = 320;
const HEIGHT = 200;

/** 主题色板：按标题哈希取一个，保证同一个 artifact 永远同一个色。 */
const PALETTES = [
  { from: "#1f4d8f", to: "#2f7bd1", ink: "#f4f8ff" },
  { from: "#1f6f5c", to: "#2fa383", ink: "#f2fbf7" },
  { from: "#7a3f8f", to: "#b06ad0", ink: "#fbf5ff" },
  { from: "#8f4a1f", to: "#d1792f", ink: "#fff8f2" },
  { from: "#2b3a55", to: "#4d648f", ink: "#f5f8ff" },
  { from: "#8f1f4a", to: "#d12f6f", ink: "#fff5f8" },
];

/**
 * FNV-1a 32 位：不需要密码学强度，只需要稳定。
 * @param {string} text
 * @returns {number}
 */
export function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * @param {string} text
 * @returns {{ from: string, to: string, ink: string }}
 */
export function paletteFor(text) {
  return PALETTES[hashText(text) % PALETTES.length];
}

/**
 * 从正文里抽第一行标题，用来给封面做副标题。
 * 只做字符串扫描，不解析 DOM——封面生成要能在 host 侧同步完成。
 * `kind` 决定扫描方式：html 找 `<h1>`/`<title>`，markdown 找 `# 标题`，
 * json 找顶层 `title`/`name` 字段，csv 取首行，image 没有正文。
 * @param {string} html
 * @param {string} [kind]
 * @returns {string}
 */
export function firstHeading(html, kind = "html") {
  const source = String(html ?? "");
  if (kind === "markdown") {
    const htmlHeading = firstHeading(source, "html");
    const markdown = /^[ \t]{0,3}#{1,3}[ \t]+(.+)$/mu.exec(source)?.[1] ?? "";
    const picked = markdown.trim() === "" ? htmlHeading : markdown;
    return cleanupHeading(picked);
  }
  if (kind === "json") {
    try {
      const parsed = JSON.parse(source);
      for (const key of ["title", "name", "heading", "summary"]) {
        if (parsed !== null && typeof parsed === "object" && typeof parsed[key] === "string")
          return cleanupHeading(parsed[key]);
      }
    } catch {
      // 不是合法 JSON：退化成首行文本。
    }
    return cleanupHeading(source.split("\n").find((line) => line.trim() !== "") ?? "");
  }
  if (kind === "csv") {
    return cleanupHeading(source.split("\n").find((line) => line.trim() !== "") ?? "");
  }
  const heading = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/iu.exec(source);
  const raw = heading?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(source)?.[1] ?? "";
  return cleanupHeading(raw);
}

/**
 * @param {string} raw
 * @returns {string}
 */
function cleanupHeading(raw) {
  return decodeEntities(String(raw).replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

/**
 * 极简实体解码：封面只需要能读的文本，不追求完整 HTML 规范。
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

/**
 * XML 文本转义（放进 <text> 里）。
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  return String(text)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

/**
 * 按视觉宽度折行：CJK 记 1，ASCII 记 0.55，最多 `maxLines` 行。
 * @param {string} text
 * @param {number} maxUnits
 * @param {number} maxLines
 * @returns {string[]}
 */
export function wrapTitle(text, maxUnits = 18, maxLines = 2) {
  const chars = [...text];
  /** @type {string[]} */
  const lines = [];
  let current = "";
  let units = 0;
  for (const char of chars) {
    const width = /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) ? 1 : 0.55;
    if (units + width > maxUnits && current !== "") {
      lines.push(current);
      if (lines.length === maxLines) break;
      current = "";
      units = 0;
    }
    current += char;
    units += width;
  }
  if (current !== "" && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    const consumed = lines.join("").length;
    if (consumed < chars.length) lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
  }
  return lines;
}

/**
 * 生成封面 SVG。
 * @param {{ title?: string, html?: string, id?: string, kind?: string }} input
 * @returns {string}
 */
export function createCoverSvg(input) {
  const title = String(input?.title ?? "").trim() || "Artifact";
  const kind = String(input?.kind ?? "").trim();
  const heading = firstHeading(String(input?.html ?? ""), kind);
  const palette = paletteFor(String(input?.id ?? title));
  const lines = wrapTitle(title, 16, 2);
  const titleMarkup = lines
    .map(
      (line, index) =>
        `<text x="24" y="${78 + index * 30}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Noto Sans CJK SC', sans-serif" font-size="24" font-weight="650" fill="${palette.ink}">${escapeXml(line)}</text>`,
    )
    .join("");
  const subtitleY = 78 + lines.length * 30 + 6;
  const subtitle =
    heading === ""
      ? ""
      : `<text x="24" y="${subtitleY}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Noto Sans CJK SC', sans-serif" font-size="12" fill="${palette.ink}" opacity="0.78">${escapeXml(heading.slice(0, 46))}</text>`;
  const badge =
    kind === ""
      ? ""
      : `<g><rect x="${WIDTH - 24 - 4 - kind.length * 7}" y="${HEIGHT - 40}" rx="9" width="${4 + kind.length * 7 + 12}" height="20" fill="${palette.ink}" opacity="0.16"/><text x="${WIDTH - 24 - kind.length * 3.5 + 2}" y="${HEIGHT - 26}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif" font-size="11" fill="${palette.ink}" opacity="0.9">${escapeXml(kind)}</text></g>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(title)}">`,
    "<defs>",
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.from}"/><stop offset="1" stop-color="${palette.to}"/></linearGradient>`,
    "</defs>",
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>`,
    `<circle cx="${WIDTH - 18}" cy="18" r="86" fill="${palette.ink}" opacity="0.06"/>`,
    `<circle cx="6" cy="${HEIGHT - 10}" r="64" fill="${palette.ink}" opacity="0.05"/>`,
    `<rect x="0" y="0" width="${WIDTH}" height="6" fill="${palette.ink}" opacity="0.25"/>`,
    titleMarkup,
    subtitle,
    badge,
    "</svg>",
  ].join("");
}

/**
 * 转成可以直接放进 <img src> 的 data URI。
 * @param {string} svg
 * @returns {string}
 */
export function coverDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
