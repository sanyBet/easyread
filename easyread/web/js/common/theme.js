/* 顶栏的深色 / 浅色切换按钮（文献库页、阅读页都有）。点一下在浅色和深色之间切；
   “跟随系统”在设置 → 界面主题里选。 */
window.PR = window.PR || {};
(function (PR) {
  "use strict";

  const dark = () => document.documentElement.dataset.theme === "dark";

  function paint(btn) {
    btn.innerHTML = PR.icon(dark() ? "sun" : "moon");
    btn.title = dark() ? PR.t("换成浅色") : PR.t("换成深色");
  }

  PR.toggleTheme = function () {
    const next = dark() ? "light" : "dark";
    if (PR.setPref && PR.prefs) PR.setPref("theme", next);  // 阅读页：和 Aa 面板里的主题是同一个设置
    else {
      const p = PR.ls.get("easyread-prefs", {});
      p.theme = next;
      PR.ls.set("easyread-prefs", p);
      PR.applyTheme(next);
      if (PR.savePrefs) PR.savePrefs("reader", { theme: next });
    }
    PR.$$(".theme-btn").forEach(paint);
  };

  /* 放在顶栏的语言 / 阅读设置按钮前面 */
  document.addEventListener("DOMContentLoaded", () => {
    const before = document.querySelector("#langBtn, #bar [data-act='settings']");
    if (!before) return;
    const btn = document.createElement("button");
    btn.className = "btn icon theme-btn";
    btn.onclick = PR.toggleTheme;
    before.parentNode.insertBefore(btn, before);
    paint(btn);
    // 跟随系统时，系统切换深浅色、或在设置里改了主题，图标跟着变
    new MutationObserver(() => paint(btn)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  });
})(window.PR);
