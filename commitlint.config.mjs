// @ts-check
import { readdirSync } from "node:fs";

/** 插件 scope = packages/ 下的目录名；另加几个仓库级 scope */
const pluginScopes = readdirSync(new URL("./packages/", import.meta.url), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const repoScopes = ["repo", "docs", "deps", "ci", "release", "scripts", "template", "types"];

export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", [...pluginScopes, ...repoScopes]],
    // 中文标题不适用大小写规则
    "subject-case": [0],
    "header-max-length": [2, "always", 100],
  },
};
