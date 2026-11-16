// @ts-check
// host 半入口：导出 Typert Remote Service 类本身（Cordis 插件形态）。
// Remote 方法声明在 ./service.js 里这个被导出类的自身原型上；
// 不要再包一层子类，否则 /api/casefile/* 会 404（docs/runtime/0.2.1-rc.5.md §6.10）。
export { CasefileService, CasefileService as default } from "./service.js";
