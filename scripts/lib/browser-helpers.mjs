// @ts-check
// 浏览器侧（ego-browser nodejs 里执行）的共享源码片段。
//
// 这些字符串会被插值进各冒烟脚本的 browserScript 模板里执行；之所以不做成普通模块，是因为
// ego 的脚本是**一整段源码**（没有 import），共享只能靠拼源码。
//
// 2026-11-20：首启「预览版说明」会比第一次点击晚一拍出现，一次性点击会漏关；弹窗盖住输入框/
// 设置入口后，整段断言空转（索引冒烟、advisor 冒烟、session-* 都踩过）。这段轮询逻辑原先在
// 6 个脚本里各抄一份，收成一处，避免第 7 份出现时再次漂移。

/**
 * 在 ego-browser 脚本里定义：
 * - `noticeDialogOn(target)`：返回当前「预览版说明」弹窗的文本（没有则空串）；
 * - `dismissNoticesOn(target)`：轮询点击关闭按钮直到弹窗真正消失，返回是否已关闭；
 * - `dismissNotice()`：等价于 `dismissNoticesOn(page)`，供既有调用点少改。
 *
 * 用 `String.raw` 保留正则里的反斜杠（插值进模板字面量时不会被转义吞掉）。
 */
export const NOTICE_DISMISS_SOURCE = String.raw`
const noticeDialogOn = (target) => target.evaluate(() => {
  const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')];
  const dialog = dialogs.find((d) => /预览版说明|Preview notes|开始使用|Get started/i.test(d.textContent || ""));
  return dialog ? (dialog.textContent || "").slice(0, 120) : "";
});
const dismissNoticesOn = async (target) => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if ((await noticeDialogOn(target).catch(() => "")) === "") return true;
    await target.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')];
      const dialog = dialogs.find((d) => /预览版说明|Preview notes|开始使用|Get started/i.test(d.textContent || ""));
      if (!dialog) return false;
      const buttons = [...dialog.querySelectorAll("button,[role=button]")];
      const label = (b) => ((b.getAttribute("aria-label") || "") + " " + (b.textContent || "")).trim();
      const button = buttons.find((b) => /^(继续|开始使用|跳过|关闭|Continue|Get started|Skip|Close)$/.test(label(b)))
        || buttons.find((b) => (b.textContent || "").trim() === "");
      if (!button) return false;
      button.click();
      return true;
    }).catch(() => false);
    await target.waitForTimeout(400);
  }
  return (await noticeDialogOn(target).catch(() => "")) === "";
};
const dismissNotice = () => dismissNoticesOn(page);
`;
