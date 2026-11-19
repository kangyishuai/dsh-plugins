// @ts-check
// core/png.js：极简 PNG 解码 + 像素比对。纯 Node（node:zlib），不引第三方依赖。
//
// 为什么自己写：仓库约定不引入打包器/依赖；而 web checker 必须能比较两张截图。
// 只支持 8-bit、非隔行、颜色类型 2（RGB）与 6（RGBA）——覆盖 puppeteer/playwright 默认截图。
//
// 比对口径：同尺寸逐像素算「平均绝对差」（0–255），相似度 = 1 - mad/255。
// 阈值是**信号**，最终判定还要叠加行为检查（见 spec/03-acceptance.md §3.4）。

import { inflateSync } from "node:zlib";

/** PNG 解码错误。 */
export class PngError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "PngError";
    this.code = "png-invalid";
  }
}

/**
 * @param {Buffer} buf
 * @param {number} start
 * @returns {number}
 */
function readU32(buf, start) {
  return buf.readUInt32BE(start);
}

/**
 * 解析 PNG。
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, channels: number, data: Buffer }}
 */
export function decodePng(buf) {
  if (buf.length < 8 || buf.toString("binary", 0, 8) !== "\x89PNG\r\n\x1a\n") {
    throw new PngError("不是 PNG 文件");
  }
  let offset = 8;
  /** @type {{ width: number, height: number, bitDepth: number, colorType: number, interlace: number } | null} */
  let header = null;
  /** @type {Buffer[]} */
  const idat = [];
  while (offset + 8 <= buf.length) {
    const length = readU32(buf, offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buf.subarray(dataStart, dataStart + length);
    if (type === "IHDR") {
      header = {
        width: readU32(data, 0),
        height: readU32(data, 4),
        bitDepth: data[8] ?? 0,
        colorType: data[9] ?? 0,
        interlace: data[12] ?? 0,
      };
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4;
  }
  if (!header) throw new PngError("缺少 IHDR");
  if (header.bitDepth !== 8) throw new PngError(`只支持 8-bit，收到 ${header.bitDepth}`);
  if (header.interlace !== 0) throw new PngError("不支持隔行 PNG");
  const channels = header.colorType === 2 ? 3 : header.colorType === 6 ? 4 : 0;
  if (channels === 0) throw new PngError(`不支持的颜色类型 ${header.colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const out = Buffer.alloc(header.height * stride);
  let pos = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[pos + x] ?? 0;
      const left = x >= channels ? out[rowStart + x - channels] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;
      let value = rawByte;
      if (filter === 1) value = (rawByte + left) & 0xff;
      else if (filter === 2) value = (rawByte + up) & 0xff;
      else if (filter === 3) value = (rawByte + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        value = (rawByte + predictor) & 0xff;
      } else if (filter !== 0) {
        throw new PngError(`未知的过滤类型 ${filter}`);
      }
      out[rowStart + x] = value;
    }
    pos += stride;
  }
  return { width: header.width, height: header.height, channels, data: out };
}

/**
 * 比较两张图（同尺寸）。返回相似度与差异统计。
 * @param {ReturnType<typeof decodePng>} a
 * @param {ReturnType<typeof decodePng>} b
 * @returns {{ similarity: number, meanAbsDiff: number, diffPixels: number, totalPixels: number, sizeMismatch: boolean }}
 */
export function compareImages(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return {
      similarity: 0,
      meanAbsDiff: 255,
      diffPixels: a.width * a.height,
      totalPixels: a.width * a.height,
      sizeMismatch: true,
    };
  }
  const pixels = a.width * a.height;
  let sum = 0;
  let diffPixels = 0;
  for (let i = 0; i < pixels; i += 1) {
    let worst = 0;
    for (let c = 0; c < 3; c += 1) {
      const av = a.data[i * a.channels + c] ?? 0;
      const bv = b.data[i * b.channels + c] ?? 0;
      worst = Math.max(worst, Math.abs(av - bv));
    }
    sum += worst;
    if (worst > 0) diffPixels += 1;
  }
  const meanAbsDiff = sum / pixels;
  return {
    similarity: 1 - meanAbsDiff / 255,
    meanAbsDiff,
    diffPixels,
    totalPixels: pixels,
    sizeMismatch: false,
  };
}

/**
 * 判一张图「有没有信息量」——用来挡"截图空白/纯色却判通过"的假成功。
 *
 * 判定：颜色种类很少 **且** 单一颜色占比极高 → 视为空白。
 * 阈值刻意保守（0.995 / 8 色），因为误判正常截图的代价比漏判高：
 * 一个带小图标的页面会有几十种颜色、主色占比也不会到 99.5%。
 *
 * @param {ReturnType<typeof decodePng>} image
 * @returns {{ blank: boolean, uniqueColors: number, dominantRatio: number }}
 */
export function assessPngInformation(image) {
  const pixels = image.width * image.height;
  if (pixels <= 0) return { blank: true, uniqueColors: 0, dominantRatio: 1 };
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (let i = 0; i < pixels; i += 1) {
    const at = i * image.channels;
    // 只按 RGB 归并（忽略 alpha），避免同一颜色因 alpha 差异被当成多色
    const key =
      ((image.data[at] ?? 0) << 16) | ((image.data[at + 1] ?? 0) << 8) | (image.data[at + 2] ?? 0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let dominant = 0;
  for (const value of counts.values()) if (value > dominant) dominant = value;
  const dominantRatio = dominant / pixels;
  const uniqueColors = counts.size;
  return {
    blank: dominantRatio >= 0.995 && uniqueColors <= 8,
    uniqueColors,
    dominantRatio,
  };
}

/**
 * 比较两个 PNG 文件的内容（Buffer 入参，便于测试与调用方复用）。
 * @param {Buffer} reference
 * @param {Buffer} candidate
 * @returns {ReturnType<typeof compareImages>}
 */
export function comparePng(reference, candidate) {
  return compareImages(decodePng(reference), decodePng(candidate));
}
