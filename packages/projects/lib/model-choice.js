// @ts-check
// 模型目录（`sessionController.modelCatalog`）的**判定与提示**（审计 AUD-PROJ-24）。
//
// 背景：线程/协调者的项目级默认模型是「部署 + 模型目录」相关值，换 provider 之后很容易失效。
// 以前落盘时不校验，跑到 `createThread` 时 selectModel 失败只写一条审计（真实数据里发生过
// 5 次「Select an available model before sending a message.」），界面上完全无感——用户以为
// 项目默认模型生效了，实际跑的是宿主默认。
//
// 这里只做纯函数：宿主目录结构不是稳定契约，认不出来就**不校验**（不假装成功也不误拒）。

/**
 * 从 catalog 里摊平出 `{provider, model}` 列表。
 * 结构与 client.js 的渲染口径一致：`groups[]`（id/provider/name）→ `models[]`（id/model/name）。
 * @param {any} catalog
 * @returns {{ provider: string, model: string }[]}
 */
export function catalogChoices(catalog) {
  const groups = Array.isArray(catalog)
    ? catalog
    : Array.isArray(catalog?.groups)
      ? catalog.groups
      : [];
  /** @type {{ provider: string, model: string }[]} */
  const out = [];
  for (const group of groups) {
    const models = Array.isArray(group?.models)
      ? group.models
      : Array.isArray(group?.items)
        ? group.items
        : [];
    const provider = String(group?.id ?? group?.provider ?? group?.name ?? "");
    for (const entry of models) {
      const model =
        typeof entry === "string" ? entry : String(entry?.id ?? entry?.model ?? entry?.name ?? "");
      if (model === "") continue;
      out.push({ provider, model });
    }
  }
  return out;
}

/**
 * 校验一个 `{provider, model}` 是否在目录里。
 *
 * 四种结果：
 *  - `checked:false, reason:'model/empty'` → 没写模型（继承宿主默认），没什么可校验
 *  - `checked:false, reason:'catalog-unavailable'` → 目录拿不到/为空，**无法判断**（写入口放过）
 *  - `checked:false, reason:'provider-unknown'` → 目录里根本没有这个 provider，**无法判断**
 *  - `checked:true, found:true` → 命中
 *  - `checked:true, found:false` → 明确不在目录里（写入口应当拒绝并给可读原因）
 *
 * 为什么 provider 不在目录里要按「无法判断」处理（B3 复审 P0 的回归修正）：
 * `sessionController.modelCatalog` 只列出**当前部署可用**的 provider，而项目级默认模型允许
 * 手填（无凭据部署 / 目录未覆盖的部署特有 provider，见 client 的「手填」兜底）。
 * 目录不认识这个 provider，就没有任何依据说这条模型不可用——判成 not-found 会把
 * 「手填一个目录外的 provider + 部署特有 effort」整条写入拒掉（web 冒烟 F42 就是这么红的）。
 * 反过来，provider 在目录里而模型不在，才是 AUD-PROJ-24 要抓的真事（换 provider 后默认模型失效）。
 * @param {any} catalog
 * @param {{ provider?: string, model?: string }} choice
 * @returns {{ checked: boolean, found: boolean, reason: string }}
 */
export function checkCatalogChoice(catalog, choice) {
  const model = String(choice?.model ?? "").trim();
  if (model === "") return { checked: false, found: false, reason: "model/empty" };
  const choices = catalogChoices(catalog);
  if (choices.length === 0) return { checked: false, found: false, reason: "catalog-unavailable" };
  const provider = String(choice?.provider ?? "").trim();
  // 目录里有 provider 字段（group.id/provider/name）但没有这个 provider → 目录对这条选择没有发言权。
  if (provider !== "" && !choices.some((item) => item.provider === provider)) {
    return { checked: false, found: false, reason: "provider-unknown" };
  }
  const found = choices.some(
    (item) =>
      item.model === model &&
      (provider === "" || item.provider === "" || item.provider === provider),
  );
  return { checked: true, found, reason: found ? "" : "model/unavailable" };
}

/**
 * 写入口拒绝时的可读原因（中英各一句太啰嗦，这里给稳定的错误码 + 人类可读尾注）。
 * @param {{ provider?: string, model?: string }} choice
 * @returns {string}
 */
export function modelUnavailableMessage(choice) {
  const provider = String(choice?.provider ?? "").trim();
  const model = String(choice?.model ?? "").trim();
  return `projects: model-unavailable (${provider === "" ? "" : `${provider}/`}${model}) — pick a model that exists in the current model catalog, or clear the default to inherit the host default`;
}
