// @ts-check
// 单元测试：core/png.js（自造 PNG，不依赖外部夹具）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import { compareImages, comparePng, decodePng, PngError } from "../lib/core/png.js";

/**
 * 最小 PNG 编码器（8-bit、RGB/RGBA、filter 0），只为测试用。
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @param {(x: number, y: number) => number[]} paint 返回 length=channels 的像素
 * @returns {Buffer}
 */
function encodePng(width, height, channels, paint) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const pixel = paint(x, y);
      for (let c = 0; c < channels; c += 1) {
        raw[y * (stride + 1) + 1 + x * channels + c] = pixel[c] ?? 0;
      }
    }
  }
  const colorType = channels === 4 ? 6 : 2;
  /** @type {Buffer[]} */
  const chunks = [];
  /** @param {string} type @param {Buffer} data */
  const chunk = (type, data) => {
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
  ihdr[9] = colorType;
  chunk("IHDR", ihdr);
  chunk("IDAT", deflateSync(raw));
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

/** @type {Uint32Array | undefined} */
let crcTable;

/**
 * CRC32（PNG 用）。
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

test("解码 RGB PNG：尺寸与像素正确", () => {
  const png = encodePng(3, 2, 3, (x, y) => [x * 10, y * 20, 7]);
  const decoded = decodePng(png);
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.channels, 3);
  assert.deepEqual([...decoded.data.subarray(0, 3)], [0, 0, 7]);
  assert.deepEqual([...decoded.data.subarray(3, 6)], [10, 0, 7]);
});

test("解码 RGBA PNG：保留 alpha 通道", () => {
  const png = encodePng(2, 1, 4, () => [1, 2, 3, 4]);
  const decoded = decodePng(png);
  assert.equal(decoded.channels, 4);
  assert.deepEqual([...decoded.data.subarray(0, 4)], [1, 2, 3, 4]);
});

test("相同图相似度为 1", () => {
  const a = encodePng(4, 4, 3, (x, y) => [x * 16, y * 16, 128]);
  const result = comparePng(a, a);
  assert.equal(result.similarity, 1);
  assert.equal(result.diffPixels, 0);
});

test("一个像素变化 → 相似度略降但仍有差异", () => {
  const a = encodePng(4, 4, 3, () => [0, 0, 0]);
  const b = encodePng(4, 4, 3, (x, y) => (x === 0 && y === 0 ? [255, 0, 0] : [0, 0, 0]));
  const result = comparePng(a, b);
  assert.ok(result.similarity > 0.9 && result.similarity < 1);
  assert.equal(result.diffPixels, 1);
  assert.equal(result.totalPixels, 16);
});

test("尺寸不同 → sizeMismatch 且相似度为 0", () => {
  const a = encodePng(2, 2, 3, () => [0, 0, 0]);
  const b = encodePng(3, 2, 3, () => [0, 0, 0]);
  const result = comparePng(a, b);
  assert.equal(result.sizeMismatch, true);
  assert.equal(result.similarity, 0);
});

test("整图颜色差异 → 相似度接近 0", () => {
  const black = encodePng(2, 2, 3, () => [0, 0, 0]);
  const white = encodePng(2, 2, 3, () => [255, 255, 255]);
  assert.ok(comparePng(black, white).similarity < 0.01);
});

test("非 PNG 输入抛 PngError", () => {
  assert.throws(() => decodePng(Buffer.from("nope")), PngError);
});

test("compareImages 直接比解码结果（同参考）", () => {
  const png = encodePng(2, 1, 3, () => [9, 9, 9]);
  const decoded = decodePng(png);
  assert.equal(compareImages(decoded, decoded).similarity, 1);
});
