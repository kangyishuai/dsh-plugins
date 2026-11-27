// @ts-check
// 封面生成单测：纯函数，不碰文件系统。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  coverDataUri,
  createCoverSvg,
  firstHeading,
  hashText,
  paletteFor,
  wrapTitle,
} from "../lib/cover.js";

test("生成合法 SVG 根节点与尺寸", () => {
  const svg = createCoverSvg({
    id: "demo-1",
    title: "Q3 复盘",
    html: "<h1>概览</h1>",
    kind: "artifact",
  });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
  assert.match(svg, /width="320"/u);
  assert.match(svg, /height="200"/u);
  assert.ok(svg.endsWith("</svg>"));
  assert.ok(
    Buffer.byteLength(svg) < 4096,
    `cover should stay small, got ${Buffer.byteLength(svg)}`,
  );
});

test("标题里的 XML 特殊字符被转义，不会注入标签", () => {
  const svg = createCoverSvg({ title: '<script>alert("x")</script>', html: "" });
  assert.equal(svg.includes("<script>"), false);
  assert.ok(svg.includes("&lt;script&gt;"));
});

test("同一个 id 永远得到同一个色板（可缓存）", () => {
  const first = paletteFor("demo-1");
  const second = createCoverSvg({ id: "demo-1", title: "a" });
  const third = createCoverSvg({ id: "demo-1", title: "b" });
  const from = /stop-color="(#[0-9a-f]{6})"/u.exec(second)?.[1];
  assert.equal(from, first.from);
  assert.equal(from, /stop-color="(#[0-9a-f]{6})"/u.exec(third)?.[1]);
});

test("不同 id 会散到不同色板（至少不是全部相同）", () => {
  const colors = new Set(
    Array.from({ length: 24 }, (_, index) => paletteFor(`artifact-${index}`).from),
  );
  assert.ok(colors.size > 1, `expected more than one palette, got ${colors.size}`);
});

test("hashText 稳定且为非负 32 位", () => {
  assert.equal(hashText("demo"), hashText("demo"));
  assert.notEqual(hashText("demo"), hashText("demoo"));
  for (const value of ["", "a", "中文标题", "x".repeat(100)]) {
    const hash = hashText(value);
    assert.ok(Number.isInteger(hash) && hash >= 0 && hash <= 0xffffffff);
  }
});

test("firstHeading 优先 h1，其次 title，并去掉标签与实体", () => {
  assert.equal(firstHeading("<h1>Hello <em>world</em></h1><title>t</title>"), "Hello world");
  assert.equal(firstHeading("<p>x</p><title>Only title</title>"), "Only title");
  assert.equal(firstHeading("<h2>A &amp; B</h2>"), "A & B");
  assert.equal(firstHeading("<p>no heading</p>"), "");
});

test("wrapTitle 按视觉宽度折行，超长补省略号", () => {
  assert.deepEqual(wrapTitle("short", 18, 2), ["short"]);
  const cjk = wrapTitle("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十", 10, 2);
  assert.equal(cjk.length, 2);
  assert.ok(cjk[1].endsWith("…"), `expected ellipsis, got ${JSON.stringify(cjk)}`);
  const ascii = wrapTitle("a very long english title that cannot fit", 10, 2);
  assert.equal(ascii.length, 2);
  assert.ok(ascii.every((line) => line.length > 0));
});

test("coverDataUri 输出可直接用于 img src", () => {
  const uri = coverDataUri(createCoverSvg({ title: "x" }));
  assert.ok(uri.startsWith("data:image/svg+xml;base64,"));
  const decoded = Buffer.from(uri.slice("data:image/svg+xml;base64,".length), "base64").toString(
    "utf8",
  );
  assert.ok(decoded.startsWith("<svg"));
});

test("firstHeading 认识 markdown / json / csv 的标题", () => {
  assert.equal(firstHeading("# 周报\n\n正文", "markdown"), "周报");
  // 取的是第一个**标题行**（前面没有标题的正文不算）。
  assert.equal(firstHeading("前言\n\n## 二级标题", "markdown"), "二级标题");
  assert.equal(firstHeading("<h1>HTML 标题</h1>\n正文", "markdown"), "HTML 标题");
  assert.equal(firstHeading('{"title":"数据概览","a":1}', "json"), "数据概览");
  assert.equal(firstHeading('{"name":"命名"}', "json"), "命名");
  assert.equal(firstHeading("not json", "json"), "not json");
  assert.equal(firstHeading("a,b,c\n1,2,3", "csv"), "a,b,c");
  assert.equal(firstHeading("<svg/>", "image"), "");
});

test("封面按 kind 打类型徽章，非 html 也能生成合法 SVG", () => {
  for (const kind of ["html", "markdown", "json", "csv", "image"]) {
    const svg = createCoverSvg({ id: `k-${kind}`, title: "样例", html: "", kind });
    assert.ok(svg.startsWith("<svg"), `${kind} should render`);
    assert.ok(svg.includes(`>${kind}</text>`), `${kind} badge missing`);
    assert.ok(Buffer.byteLength(svg) < 4096);
  }
});
