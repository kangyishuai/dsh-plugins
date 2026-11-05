# 文档索引

> 文档目前只有中文。English readers: start with the root [README](../README.md) and each plugin's README; the design docs below are in Chinese.

| 文档                                           | 内容                                                            | 什么时候读                         |
| ---------------------------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| [plugin-conventions.md](plugin-conventions.md) | 插件包结构、命名、版本与兼容性、测试要求                        | 写新插件之前                       |
| [runtime/](runtime/)                           | 针对具体 DSH 版本的勘察记录：宿主服务、slot、磁盘布局、已知的坑 | 调用宿主 API 或 DSH 升级时         |
| [adr/](adr/README.md)                          | 架构决策记录：为什么这么设计                                    | 想改设计、或者好奇「为什么不……」时 |
| [testing/](testing/)                           | 各插件的测试清单：自动化、启动冒烟、GUI 手测                    | 发版前、DSH 升级后                 |

仓库级的约定在根目录：[CONTRIBUTING.md](../CONTRIBUTING.md)（给人看）、[AGENTS.md](../AGENTS.md)（给 AI agent 看）、[SECURITY.md](../SECURITY.md)。
