// @ts-check
// host 半入口：Cordis 插件（类形态）。Remote 方法必须定义在导出的这个类自身的原型上，
// 否则 Typert 网关不会 claim 端点（不要包一层子类）。
// 模型工具 session_delete 在 SessionDeleteService 构造函数里注册。
import { SessionDeleteService } from "./service.js";

export { SessionDeleteService };
export default SessionDeleteService;
