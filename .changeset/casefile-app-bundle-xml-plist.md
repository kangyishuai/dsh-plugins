---
"@kangyishuai/dsh-casefile": patch
---

修 `case_app inspect` 的一个真实 bug：**Info.plist 可能是 XML 或二进制，不能直接 `JSON.parse`**。

实测拿 Bob.app 跑就炸了（`Unexpected token '<', "<?xml vers"... is not valid JSON`）。现在统一先用 `plutil -convert json -o -` 转换；runner 不可用时，只在文件本身就是 JSON 形式时接受，否则报 `invalid-input` 并说明需要在 macOS 上用 plutil。

回归测试直接用 XML plist 构造应用包（反证过：把 plutil 那行去掉测试立刻红）。
