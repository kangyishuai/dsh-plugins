// @ts-check
// host 半入口：导出 Typert Remote Service 类本身（Cordis 插件形态）。
// Remote 方法必须声明在这个被导出的类自身原型上（见 ./service.js 的 declareRemote），
// 不要再包一层子类，否则 /api/advisor/* 会 404（docs/runtime/0.2.1-rc.5.md §6.10）。
export { AdvisorService, AdvisorService as default } from "./service.js";
