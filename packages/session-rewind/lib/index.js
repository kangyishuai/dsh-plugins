// @ts-check
// host 半入口：导出 Typert Remote Service 类本身（Cordis 插件形态）。
// Remote 方法必须声明在这个类自身的原型上，否则网关不会 claim 端点（不要包一层子类）。
import { SessionRewindService } from "./service.js";

export { SessionRewindService };
export default SessionRewindService;
