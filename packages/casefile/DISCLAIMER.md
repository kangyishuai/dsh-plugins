# Disclaimer / 免责声明

This plugin is an **adapter** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that organizes evidence produced by [REA](https://github.com/morluto/rea). It contains none of REA's code, ships no analysis engine, and is not affiliated with DeepSeek or the REA authors.

本插件是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**适配层**，用来整理 [REA](https://github.com/morluto/rea) 产出的证据。它不包含 REA 的代码、不带分析引擎，与 DeepSeek 及 REA 作者均无关联。

## Intended use / 使用范围

- **Research and learning**, and analysis of software you **own** or are **authorized** to analyze. 研究与学习，以及分析**你拥有**或**已获授权**分析的软件。
- You are responsible for having the right to analyze the target, and for complying with the licenses, terms of service, and laws that apply to it. 你有责任确认自己有权分析目标，并遵守适用的许可、服务条款与法律。
- The plugin records an authorization tier (`owned` / `authorized` / `research`) with each project. That label records **your** attestation; it is not a legal determination and does not grant any right. 插件让每个项目记录授权档；该字段记录的是**你的**声明，不构成法律判断，也不授予任何权利。

## What this plugin deliberately does not do / 刻意不提供

- **No circumvention.** It provides no way to bypass DRM, license checks, anti-debugging, integrity checks, or authentication. It observes and records; it does not defeat protections. **不提供绕过** DRM、许可校验、反调试、完整性校验或认证的能力：它只观察与记录，不破解保护。
- **No asset reuse.** It ships no third-party assets (logos, fonts, media, binaries) and offers no mechanism to reuse them. 不捆绑、也不提供复用第三方资产（logo、字体、素材、二进制）的机制。
- **No third-party engines.** It bundles no commercial reverse-engineering engines (IDA Pro, Hopper, JEB, …). If you use them, you must hold a valid license yourself. 不捆绑商业逆向引擎；若你使用它们，请自行持有有效授权。
- **No target disclosure.** The repository and its examples contain no record of any specific third-party target. 仓库与示例中不包含任何具体第三方目标的信息。

## No warranty / 无担保

Provided "as is", without warranty of any kind. Evidence storage, redaction, and capability detection are best-effort: **review any exported spec pack before sharing it**, and verify conclusions before acting on them. 按「现状」提供，不附带任何担保。证据落盘、脱敏与能力探测都是尽力而为：**分享规格包前请自行复核**，依据结论行动前请自行验证。

Non-commercial, research-only use does not by itself exempt you from copyright, contract, or anti-circumvention rules. If you are unsure whether your use is permitted, consult a qualified professional in your jurisdiction. 非商业、仅研究用途本身并不当然免除著作权、合同或反规避规则的约束；如不确定是否可用，请咨询你所在司法辖区的专业人士。
