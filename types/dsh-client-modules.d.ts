/**
 * client 半通过 factory 的 require() 拿到的宿主模块。
 * TS 在 JS 文件里会把 require("x") 当成模块导入去解析，这里声明为 any 以免报错。
 * 这些模块由 DSH 在运行时注入，本仓库不安装它们（见 AGENTS.md「不要做的事」）。
 */
declare module "react";
declare module "react/jsx-runtime";
declare module "@deepseek-ai/*";
