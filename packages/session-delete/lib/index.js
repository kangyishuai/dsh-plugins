// @ts-check
// host 半入口：Cordis 插件（类形态），构造时探测宿主能力并注册 sessionDelete Remote 服务。
// 改动后需要重启 DSH 桌面版。
import { SessionDeleteService } from "./service.js";

export { SessionDeleteService };
export default SessionDeleteService;
