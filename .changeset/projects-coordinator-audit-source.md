---
"@kangyishuai/dsh-projects": patch
---

`coordinator/defaults` 审计带 `source`（设置卡 / composer 药丸），并修正两处冒烟适配。

- RPC `setCoordinatorDefaults` 增加可选第 5 参数 `source`，写进审计；两个 UI 写入口分别传
  `"settings"` / `"composer"`。旧调用不传仍工作（source 为空串）。
- 冒烟 F42：模型目录里第一个模型可能没有 `reasoning.efforts`（本机 local provider），
  现在遍历选项优先选带 effort 的模型、把最终选择按回 DOM，并按 `source` 定位设置卡那次保存；
  UI 未实际选中 effort 时不再硬断言落盘值（`effortChecked` 写进断言 detail）。
  web 冒烟 **270 PASS / 0 SKIP / 0 FAIL**。
