---
"@kangyishuai/dsh-advisor": minor
---

Add first-class CNY support: `currency` (USD/CNY) plus a manual `usdToCny` rate; budget and unit-price settings are stored in the selected currency while the ledger, workspace pool and guards stay in USD. Old `maxCostPerDayUsd` / `workspaceMaxCostPerDayUsd` keys migrate as USD, switching currency converts the form amounts at the rate, and status/preview/doctor/advisor-line output uses the selected currency.
