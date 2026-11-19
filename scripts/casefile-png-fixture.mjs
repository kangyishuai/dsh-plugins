// @ts-check
// 冒烟用最小 PNG 生成器（纯色 8-bit RGB），避免在仓库里放二进制夹具。
import { deflateSync } from "node:zlib";

/** @type {Uint32Array | undefined} */
let table;

/**
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 生成"有信息量"的 PNG（渐变 + 棋盘），用于 web checker 冒烟。
 *
 * 为什么需要：`web` checker 会先判"图有没有信息量"，纯色图会被直接判 fail
 * （假成功防护清单第 5 条）。冒烟里要测的是相似度阈值，所以夹具必须不是纯色。
 *
 * @param {number} width
 * @param {number} height
 * @param {[number, number, number]} base 基色；函数在此基础上做可见的渐变
 * @returns {Buffer}
 */
export function texturedPng(width, height, base) {
  /** @param {number} x @param {number} y */
  /** @param {number} x @param {number} y @returns {[number, number, number]} */
  const paint = (x, y) => [
    (base[0] + x * 17) % 256,
    (base[1] + y * 23) % 256,
    (base[2] + ((x * y) % 61)) % 256,
  ];
  return pngFromPaint(width, height, paint);
}

/**
 * 按像素函数生成 PNG（8-bit RGB）。
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} paint
 * @returns {Buffer}
 */
export function pngFromPaint(width, height, paint) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (stride + 1) + 1 + x * 3;
      const pixel = paint(x, y);
      raw[offset] = pixel[0];
      raw[offset + 1] = pixel[1];
      raw[offset + 2] = pixel[2];
    }
  }
  /** @type {Buffer[]} */
  const chunks = [];
  /**
   * @param {string} type
   * @param {Buffer} data
   */
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
  ihdr[9] = 2;
  chunk("IHDR", ihdr);
  chunk("IDAT", deflateSync(raw));
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

/**
 * 生成纯色 PNG。
 * @param {number} width
 * @param {number} height
 * @param {[number, number, number]} rgb
 * @returns {Buffer}
 */
export function solidPng(width, height, rgb) {
  return pngFromPaint(width, height, () => rgb);
}
