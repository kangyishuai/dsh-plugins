#!/usr/bin/env node
// @ts-check
// 用法：pnpm list-plugins —— 列出所有插件包名与版本
import { join } from "node:path";
import { listPluginDirs, REPO_ROOT, readJson } from "./lib/repo.mjs";

const dirs = listPluginDirs(REPO_ROOT);
if (dirs.length === 0) console.log("（packages/ 下还没有插件，用 pnpm new <name> 创建）");
for (const dir of dirs) {
  try {
    const pkg = readJson(join(REPO_ROOT, "packages", dir, "package.json"));
    console.log(`${String(pkg.name).padEnd(44)} ${pkg.version}`);
  } catch {
    console.log(`${dir.padEnd(44)} （package.json 读取失败）`);
  }
}
