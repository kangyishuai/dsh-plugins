// @ts-check
// client 半：以 classic script 原样下发到 DSH 页面，无需打包器。
// 改动后刷新页面即可。所有副作用（含 React.createElement）都必须写在 factory 里面。
// 结构沿用 docs/runtime/0.2.1-rc.5.md 记录的已验证写法。

window.__ModuleLoader__.load({
  id: "@kangyishuai/dsh-__NAME__",
  factory(require) {
    const module = { exports: /** @type {DSH.ClientModule} */ ({}) };
    const exports = module.exports;

    const React = require("react");

    exports.inject = ["slots", "locale"];
    /** @param {DSH.ClientContext} _ctx */
    exports.apply = function apply(_ctx) {
      // 示例：往会话行 "…" 菜单插一项（order 420 = Archive 之后、Copy ID 之前）
      // 真实签名是 register(descriptor, Component)：第二个参数是 React 组件，descriptor 里没有 render。
      // _ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
      //   _ctx.slots.register({ name: "sidebar.workspaces.session.menu.item", id: "__NAME__", order: 420 },
      //     () => React.createElement("span", null, "…")),
      // );
    };

    void React; // 模板占位：开始写 UI 后删掉这一行
    return module.exports;
  },
});
