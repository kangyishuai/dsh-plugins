#!/usr/bin/env node
// @ts-check
// 用法：
//   node scripts/register-test-workspace.mjs --home <DSH_HOME> --path <目录> \
//     [--title <工作区标题>] [--allow-live] [--dry-run]
//
// 把 `--path` 注册成 DSH 桌面工作区，供 `pnpm gate:<plugin> --deep --workspace <目录>` /
// `pnpm smoke:session-rewind-desktop --deep --workspace <目录>` 使用：`--deep` 的「新建会话」
// 按钮只在**已注册**的工作区下出现，而桌面走原生目录选择器、CDP 驱动不了（见
// docs/testing/session-rewind.md §2.6.1）。helper 只动 `<home>/storages/workspace.json`：
//
// - 幂等：同一目录（按 realpath）已注册就只打印 id，不写盘；
// - 安全：默认拒绝 `$HOME/.dsh` 及其子目录（真实桌面版数据根），必须显式 --allow-live；
// - 可回滚：已有文件先备份 `workspace.json.bak-<ts>`，再原子写；其它字段原样保留；
// - 可预演：--dry-run 只打印将要写的内容。
//
// 退出码：0 = 成功/已存在/dry-run；2 = 安全闸拒绝（live home）；1 = 参数或存储问题。
// 运行中的桌面版持有内存态：注册应在启动前完成，或注册后重启桌面版。
import { parseArgs } from "node:util";
import { isMain } from "./lib/repo.mjs";
import { registerTestWorkspace, WorkspaceRegisterError } from "./lib/workspace-register.mjs";

const USAGE = `用法：node scripts/register-test-workspace.mjs --home <DSH_HOME> --path <目录> [选项]

把测试目录注册成 DSH 桌面工作区（幂等；已有 workspace.json 先备份再原子写）。

必填：
  --home <dir>      DSH 数据根（桌面版默认 ~/.dsh；冒烟/CI 建议用临时 DSH_HOME）
  --path <dir>      要注册的目录，必须已存在；写盘/去重都用 realpath

可选：
  --title <name>    工作区标题，默认取目录名（--sidebar-workspace 要按它匹配）
  --allow-live      允许写真实桌面版数据根（$HOME/.dsh 及其子目录）；默认拒绝
  --dry-run         只打印计划，不写盘
  -h, --help        显示本帮助

示例：
  # 隔离实例（推荐）：临时 DSH_HOME + 专用测试目录
  node scripts/register-test-workspace.mjs --home /tmp/dsh-home --path ~/Workspace/dsh-rewind-ui-smoke

  # 真实桌面版（要在 live 桌面上跑 --deep 时才需要）
  node scripts/register-test-workspace.mjs --home ~/.dsh --path ~/Workspace/dsh-rewind-ui-smoke --allow-live
`;

/**
 * @param {string[]} argv
 * @returns {number} 进程退出码
 */
export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      home: { type: "string" },
      path: { type: "string" },
      title: { type: "string" },
      "allow-live": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  const home = typeof values.home === "string" ? values.home : "";
  const target = typeof values.path === "string" ? values.path : "";
  if (home === "" || target === "") {
    console.error(USAGE);
    return 1;
  }

  const summary = registerTestWorkspace({
    home,
    path: target,
    title: typeof values.title === "string" ? values.title : undefined,
    allowLive: values["allow-live"] === true,
    dryRun: values["dry-run"] === true,
  });

  if (summary.dryRun) {
    console.log(`dry-run：将注册 ${summary.id}（不写盘）`);
  } else if (summary.alreadyExisted) {
    console.log(`已注册 ${summary.id}（已存在，幂等跳过）`);
  } else {
    console.log(`已注册 ${summary.id}`);
    if (summary.backupFile !== null) console.log(`已备份原文件：${summary.backupFile}`);
    console.log("注册结果在桌面版下次启动时生效（运行中的实例请重启）。");
  }
  // 机器可读摘要放在最后一行，方便脚本/断言直接解析。
  console.log(
    JSON.stringify({
      registered: summary.registered,
      alreadyExisted: summary.alreadyExisted,
      id: summary.id,
      path: summary.path,
      title: summary.title,
      home: summary.home,
      storeFile: summary.storeFile,
      backupFile: summary.backupFile,
      dryRun: summary.dryRun,
      written: summary.written,
    }),
  );
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof WorkspaceRegisterError) {
      const prefix = error.code === "safety" ? "拒绝" : "错误";
      console.error(`${prefix}：${error.message}`);
      process.exitCode = error.code === "safety" ? 2 : 1;
    } else {
      console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
