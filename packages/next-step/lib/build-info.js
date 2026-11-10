// @ts-check
// 运行时自证的构建身份：版本号 + 构建哈希。
//
// 为什么需要它：插件装没装、装的是哪个版本，过去只能靠 `dsh plugin list`、profile 的 lock 文件、
// 或者启动日志去侧面推断。这里让插件自己报出来——`diagnostics` RPC 会带上 `version` 与
// `buildHash`，和 `dsh plugin list` / npm 上的 tarball 一比就能确认「现在跑的是不是那份代码」。
//
// 只依赖 Node 内置模块，不进宿主包，因此可以用 `node --test` 直接测。
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 插件包根目录（本文件在 <root>/lib/ 下）。 */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * 参与构建哈希的条目（相对包根）。刻意不含 README / LICENSE：
 * 它们不影响行为，改文档不该让用户看到「构建变了」。
 */
const HASHED_ENTRIES = ["package.json", "cordis.patch.yml", "lib", "locale"];

/**
 * 递归收集普通文件（不跟随符号链接）。
 * @param {string} absolute 绝对路径
 * @param {string[]} out 收集结果
 * @returns {Promise<void>}
 */
async function collect(absolute, out) {
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (_error) {
    return;
  }
  for (const entry of entries) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) await collect(child, out);
    else if (entry.isFile()) out.push(child);
  }
}

/**
 * 归一化相对路径：统一用 `/`，保证 macOS / Linux / Windows 上哈希一致。
 * @param {string} absolute
 * @returns {string}
 */
function relativeKey(absolute) {
  return relative(PACKAGE_ROOT, absolute).split(sep).join("/");
}

/**
 * 计算一次构建身份：读 package.json 的 version，并对参与构建的文件做 sha256。
 * @returns {Promise<{ version: string, buildHash: string, buildFiles: number, packagePath: string }>}
 */
export async function computeBuildIdentity() {
  const pkgText = await readFile(join(PACKAGE_ROOT, "package.json"), "utf8");
  /** @type {{ version?: unknown }} */
  const pkg = JSON.parse(pkgText);
  const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";

  /** @type {string[]} */
  const absoluteFiles = [];
  for (const entry of HASHED_ENTRIES) {
    const absolute = join(PACKAGE_ROOT, entry);
    try {
      const stats = await readdir(absolute, { withFileTypes: true });
      if (Array.isArray(stats)) await collect(absolute, absoluteFiles);
    } catch (_error) {
      // 不是目录：当作单文件处理（package.json / cordis.patch.yml）
      absoluteFiles.push(absolute);
    }
  }

  /** @type {{ key: string, path: string }[]} */
  const files = absoluteFiles
    .map((path) => ({ key: relativeKey(path), path }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));

  const hash = createHash("sha256");
  for (const file of files) {
    const content = await readFile(file.path);
    hash.update(file.key);
    hash.update("\u0000");
    hash.update(String(content.length));
    hash.update("\u0000");
    hash.update(content);
    hash.update("\u0000");
  }

  return {
    version,
    buildHash: hash.digest("hex"),
    buildFiles: files.length,
    packagePath: PACKAGE_ROOT,
  };
}

/** @type {Promise<{ version: string, buildHash: string, buildFiles: number, packagePath: string }> | null} */
let cached = null;

/**
 * 缓存的构建身份（第一次调用后不再读盘；插件进程内版本不会变）。
 * @returns {Promise<{ version: string, buildHash: string, buildFiles: number, packagePath: string }>}
 */
export function buildIdentity() {
  if (cached === null) cached = computeBuildIdentity();
  return cached;
}

/**
 * 只清缓存，给测试用（运行时不会调用）。
 * @returns {void}
 */
export function resetBuildIdentityCache() {
  cached = null;
}
