/* 滑动或手指按在屏幕上时推迟远端更新的重渲染：手机上一次全量重渲染约 140ms，滑动中做会卡顿。 */
(function (PR) {
  "use strict";
  const SCROLL_IDLE_MS = 600;
  let lastScrollAt = -Infinity, isTouching = false, pendingFn = null, timer = null;

  const activity = PR.scrollActivity = {
    _now: () => performance.now(),  // 测试可替换时钟
    isActive(now) {
      const at = now === undefined ? activity._now() : now;
      return isTouching || at - lastScrollAt < SCROLL_IDLE_MS;
    },
  };

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!pendingFn || isTouching) return;  // 手指抬起时再排
    timer = setTimeout(flush, Math.max(0, lastScrollAt + SCROLL_IDLE_MS - activity._now()));
  }

  function flush() {
    timer = null;
    if (activity.isActive()) return schedule();  // 期间又滑过，顺延
    const fn = pendingFn;
    pendingFn = null;
    if (fn) fn();
  }

  PR.whenScrollIdle = function (fn) {
    if (activity.isActive()) { pendingFn = fn; if (!timer) schedule(); return; }
    pendingFn = null;  // 调用方已合并参数，最新这次覆盖之前登记的
    clearTimeout(timer);
    timer = null;
    fn();
  };

  const markScroll = () => { lastScrollAt = activity._now(); };
  window.addEventListener("scroll", markScroll, { passive: true });
  // 多指时抬起一根，其余手指仍按着
  const release = (e) => { isTouching = !!(e && e.touches && e.touches.length); markScroll(); schedule(); };
  // 手指下的节点按住期间被换掉，touchend 不再冒泡到 window，只发给原节点，所以原节点上也要听
  window.addEventListener("touchstart", (e) => {
    isTouching = true; markScroll();
    if (e && e.target && e.target.addEventListener) ["touchend", "touchcancel"].forEach((t) => e.target.addEventListener(t, release, { passive: true, once: true }));
  }, { passive: true });
  window.addEventListener("touchend", release, { passive: true });
  window.addEventListener("touchcancel", release, { passive: true });
})(window.PR);
