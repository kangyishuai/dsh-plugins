# Disclaimer / 免责声明

This plugin is an **adapter** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that organizes evidence produced by [REA](https://github.com/morluto/rea). It contains none of REA's code, ships no analysis engine, and is not affiliated with DeepSeek or the REA authors.

本插件是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**适配层**，用来整理 [REA](https://github.com/morluto/rea) 产出的证据。它不包含 REA 的代码、不带分析引擎，与 DeepSeek 及 REA 作者均无关联。

## Intended use / 使用范围

- **Research and learning**, and analysis of software you **own** or are **authorized** to analyze. 研究与学习，以及分析**你拥有**或**已获授权**分析的软件。
- You are responsible for having the right to analyze the target, and for complying with the licenses, terms of service, and laws that apply to it. 你有责任确认自己有权分析目标，并遵守适用的许可、服务条款与法律。
- The plugin records an authorization tier (`owned` / `authorized` / `research`) with each project. That label records **your** attestation; it is not a legal determination and does not grant any right. 插件让每个项目记录授权档；该字段记录的是**你的**声明，不构成法律判断，也不授予任何权利。

## Acquisition boundary: three tiers / 采集边界：三段式

casefile does not acquire content. It ingests what an operator-supplied tool produced, records the
producer's identity and access mode, and verifies claims against checks. The three tiers below describe
what this plugin supports, what requires your explicit confirmation, and what it will not provide.

casefile 本身**不采集**内容：它摄入操作者所选工具产出的东西，记录生产者身份与获取方式，再用检查去验收结论。下面三段分别说明：支持什么、什么需要你明示确认、以及不提供什么。

### Tier 1 — supported as-is / 直接支持

- **Human-equivalent access** through a real browser: headful Chromium, your own normal profile, normal
  user agent, ordinary pacing, single-page navigation. 以**人类等价**方式访问：有头浏览器、你自己的普通
  profile、正常 UA、正常节奏、单页浏览。
- **Official APIs, public archives, and cached copies** (e.g. `web.archive.org`). 官方 API、公开归档与缓存副本。
- **Ingesting artifacts produced by other tools**, with provenance recorded (see `producer`). 摄入其他工具
  产出的产物，并记录 `producer`（工具、版本、获取方式、产物类型）。

### Tier 2 — requires your explicit confirmation / 需你明示确认

- Reusing **your own** authenticated session or cookies in a tool you run yourself. 在你自行运行的工具里复用
  **你自己的**登录态或 cookie。
- Any access mode you describe as `stealth` in the producer record. 你在 `producer.mode` 里标为 `stealth` 的获取方式。

Tier 2 is recorded, not endorsed: the evidence carries `accessConfirmedByUser` plus your note, and every
report renders the producer table with a statement that the operator chose and executed the acquisition.
Tier 2 只做**记录**，不做**背书**：证据会带上 `accessConfirmedByUser` 与你填的说明，报告会渲染生产者表，
并声明采集方式由操作者选择与执行、责任归操作者。

### Tier 3 — not provided, at all / 完全不提供

- CAPTCHA solving or human-click-farm integration. 验证码识别/打码平台接入。
- TLS/HTTP2 fingerprint impersonation, or forged challenge tokens. TLS/HTTP2 指纹伪造、伪造挑战 token。
- Proxy pools or IP rotation to evade blocks. 代理池/轮换 IP 规避封禁。
- High-rate bulk scraping. 高频批量抓取。

This plugin contains no code for Tier 3, and will not gain any: casefile is an evidence and acceptance
layer, not a circumvention toolkit. If your work needs Tier 3, that belongs in a dedicated scraping tool
outside this plugin, and its legality is your determination — moving the technique to another tool does
not make it permissible. 本插件不含 Tier 3 的任何代码，也不会加入：casefile 是证据与验收层，不是规避工具
箱。若你的工作需要 Tier 3，那属于插件之外的专门采集工具，合法性由你判断——把手段挪到别的工具里，性质不变。

## What this plugin deliberately does not contain / 刻意不包含

- **No asset reuse.** It ships no third-party assets (logos, fonts, media, binaries) and offers no mechanism to reuse them. 不捆绑、也不提供复用第三方资产（logo、字体、素材、二进制）的机制。
- **No third-party engines.** It bundles no commercial reverse-engineering engines (IDA Pro, Hopper, JEB, …). If you use them, you must hold a valid license yourself. 不捆绑商业逆向引擎；若你使用它们，请自行持有有效授权。
- **No target disclosure.** The repository and its examples contain no record of any specific third-party target. 仓库与示例中不包含任何具体第三方目标的信息。

## No warranty / 无担保

Provided "as is", without warranty of any kind. Evidence storage, redaction, and capability detection are best-effort: **review any exported spec pack before sharing it**, and verify conclusions before acting on them. 按「现状」提供，不附带任何担保。证据落盘、脱敏与能力探测都是尽力而为：**分享规格包前请自行复核**，依据结论行动前请自行验证。

Non-commercial, research-only use does not by itself exempt you from copyright, contract, or anti-circumvention rules. If you are unsure whether your use is permitted, consult a qualified professional in your jurisdiction. 非商业、仅研究用途本身并不当然免除著作权、合同或反规避规则的约束；如不确定是否可用，请咨询你所在司法辖区的专业人士。
