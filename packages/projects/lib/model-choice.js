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
 * 三种结果：
 *  - `checked:false` → 目录拿不到/为空，**无法判断**（写入口应当放过并如实标注）
 *  - `checked:true, found:true` → 命中
 *  - `checked:true, found:false` → 明确不在目录里（写入口应当拒绝并给可读原因）
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
