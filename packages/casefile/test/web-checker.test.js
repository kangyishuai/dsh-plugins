// @ts-check
// web checker：截图相似度判定（自造 PNG，验证阈值、尺寸不匹配、缺文件三态）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { deflateSync } from "node:zlib";

import { createWebChecker } from "../lib/core/checks.js";

/** @type {string[]} */
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** @type {Uint32Array | undefined} */
let crcTable;

/**
 * CRC32。
 * @param {Buffer} buf
 */
function crc32(buf) {
  let table = crcTable;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crcTable = table;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => number[]} paint
 * @returns {Buffer}
 */
function encodePng(width, height, paint) {
  const channels = 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = paint(x, y);
      for (let c = 0; c < channels; c += 1) {
        raw[y * (stride + 1) + 1 + x * channels + c] = pixel[c] ?? 0;
      }
    }
  }
  /** @type {Buffer[]} */
  const chunks = [];
  const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    chunks.push(len, body, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  chunk("IHDR", ihdr);
  chunk("IDAT", deflateSync(raw));
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

/**
 * 写两张图并返回路径。
 * @param {(x: number, y: number) => number[]} refPaint
 * @param {(x: number, y: number) => number[]} candPaint
 * @param {number} [size]
 */
function fixtures(refPaint, candPaint, size = 8) {
  const dir = mkdtempSync(join(tmpdir(), "casefile-web-"));
  dirs.push(dir);
  const reference = join(dir, "ref.png");
  const candidate = join(dir, "cand.png");
  writeFileSync(reference, encodePng(size, size, refPaint));
  writeFileSync(candidate, encodePng(size, size, candPaint));
  return { reference, candidate, dir };
}

test("web checker：相同截图判 pass", async () => {
  const checker = createWebChecker();
  const { reference, candidate } = fixtures(
    (x, y) => [x * 8, y * 8, 40],
    (x, y) => [x * 8, y * 8, 40],
  );
  const result = await checker.run({ reference, candidate });
  assert.equal(result.verdict, "pass");
  assert.equal(result.detail.similarity, 1);
});

test("web checker：轻微差异（低于阈值）判 fail", async () => {
  const checker = createWebChecker();
  const { reference, candidate } = fixtures(
    () => [0, 0, 0],
    () => [40, 0, 0],
  );
  const result = await checker.run({ reference, candidate, minSimilarity: 0.98 });
  assert.equal(result.verdict, "fail");
  assert.ok(result.detail.reasons.includes("below-threshold"));
});

test("web checker：尺寸不一致判 fail（除非 allowSizeMismatch）", async () => {
  const checker = createWebChecker();
  const dir = mkdtempSync(join(tmpdir(), "casefile-web-size-"));
  dirs.push(dir);
  const reference = join(dir, "ref.png");
  const candidate = join(dir, "cand.png");
  writeFileSync(
    reference,
    encodePng(4, 4, () => [0, 0, 0]),
  );
  writeFileSync(
    candidate,
    encodePng(6, 4, () => [0, 0, 0]),
  );
  const strict = await checker.run({ reference, candidate });
  assert.equal(strict.verdict, "fail");
  assert.ok(strict.detail.reasons.includes("size-mismatch"));
  // 允许尺寸不一致不会让「零相似度」变成 pass：只是不再把 size-mismatch 单独列为失败原因
  const lenient = await checker.run({ reference, candidate, allowSizeMismatch: true });
  assert.equal(lenient.verdict, "fail");
  assert.equal(lenient.detail.reasons.includes("size-mismatch"), false);
});

test("web checker：缺文件返回 unknown（不是 pass/fail）", async () => {
  const checker = createWebChecker();
  const { reference } = fixtures(
    () => [0, 0, 0],
    () => [0, 0, 0],
  );
  const result = await checker.run({ reference, candidate: "/no/such/file.png" });
  assert.equal(result.verdict, "unknown");
  assert.equal(result.detail.reason, "screenshot-missing");
});

test("web checker：坏 PNG 返回 unknown", async () => {
  const checker = createWebChecker();
  const dir = mkdtempSync(join(tmpdir(), "casefile-web-bad-"));
  dirs.push(dir);
  const reference = join(dir, "ref.png");
  const candidate = join(dir, "cand.png");
  writeFileSync(
    reference,
    encodePng(2, 2, () => [0, 0, 0]),
  );
  writeFileSync(candidate, "not a png");
  const result = await checker.run({ reference, candidate });
  assert.equal(result.verdict, "unknown");
  assert.equal(result.detail.reason, "screenshot-invalid");
});
