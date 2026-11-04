# 0001. 纯 JS + JSDoc，不引入构建步骤

- 状态：已接受
- 日期：2026-11-04
- 涉及：repo

## 背景

DSH 的 client 半以 classic script 原样下发，host 半由 Node 直接加载 `lib/index.js`。引入 TypeScript 源码或打包器，就意味着每个插件都要多一个构建步骤、多一份产物要管理，`link:` 安装后改代码也不能立刻生效。但完全没有类型检查，又容易在调用宿主 API 时写错。

## 可选方案

1. TypeScript 源码 + tsc 编译：类型最完整；需要构建，产物和源码两套
2. 打包器（Vite/Rollup）：可以用 JSX；违反「不引入打包器」，调试链路长
3. **纯 JS + JSDoc + `tsc --noEmit`**：零构建，源码就是产物；类型表达力略弱

## 决定

选方案 3。所有源码都是 ESM JS，文件头写 `// @ts-check`。根目录 `tsconfig.json` 只做检查（`noEmit`）。宿主的类型在 `types/*.d.ts` 里手写，只声明已验证过的成员。lint 和格式化用 Biome（一个依赖搞定两件事）。

## 影响

- `link:` 安装后改完即可生效，发布包就是源码
- 宿主类型要随 DSH 升级手动维护，和 `docs/runtime/<版本>.md` 一起更新
- TS 会把 client 半 `factory(require)` 里的 `require("x")` 当成模块导入：宿主模块在 `types/dsh-client-modules.d.ts` 里声明为 any；参数未使用的检查交给 Biome
