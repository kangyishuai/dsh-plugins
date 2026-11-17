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
 * 生成纯色 PNG。
 * @param {number} width
 * @param {number} height
 * @param {[number, number, number]} rgb
 * @returns {Buffer}
 */
export function solidPng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (stride + 1) + 1 + x * 3;
      raw[offset] = rgb[0];
      raw[offset + 1] = rgb[1];
      raw[offset + 2] = rgb[2];
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
