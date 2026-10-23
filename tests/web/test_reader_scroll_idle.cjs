const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const READER = path.join(__dirname, "../../easyread/web/js/reader");

/* 假时钟 + 假计时器：advance 按到期顺序触发 */
function sandbox() {
  let now = 1000, nextId = 0;
  const timers = new Map(), listeners = new Map();
  const context = {
    performance: { now: () => now },
    setTimeout(fn, ms = 0) { timers.set(++nextId, { fn, at: now + ms }); return nextId; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { throw new Error("busy polling is not expected in these tests"); },
    clearInterval() {},
    console,
  };
  context.window = {
    addEventListener(type, fn, opts) {
      assert.equal(opts && opts.passive, true, type + " listener must be passive");
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
  };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  }
  const fire = (type) => (listeners.get(type) || []).forEach((fn) => fn({}));
  return { context, advance, fire };
}

function idle() {
  const box = sandbox();
  const PR = {};
  box.context.window.PR = PR;
  vm.runInNewContext(fs.readFileSync(path.join(READER, "scroll-idle.js"), "utf8"), box.context);
  return { PR, ...box };
}

test("runs immediately when idle", () => {
  const r = idle();
  let calls = 0;
  r.PR.whenScrollIdle(() => calls++);
  assert.equal(calls, 1);
  assert.equal(r.PR.scrollActivity.isActive(), false);
});

test("defers while scrolling and runs once after 600ms idle", () => {
  const r = idle();
  let calls = 0;
  r.fire("scroll");
  assert.equal(r.PR.scrollActivity.isActive(), true);
  r.PR.whenScrollIdle(() => calls++);
  r.PR.whenScrollIdle(() => calls++);
  assert.equal(calls, 0);
  r.advance(599);
  assert.equal(calls, 0);
  r.advance(1);
  assert.equal(calls, 1, "两次登记只执行最后一次");
  r.advance(5000);
  assert.equal(calls, 1);
});

test("continued scrolling keeps postponing", () => {
  const r = idle();
  let calls = 0;
  r.fire("scroll");
  r.PR.whenScrollIdle(() => calls++);
  r.advance(400); r.fire("scroll");
  r.advance(400);
  assert.equal(calls, 0, "最后一次滚动后还不到 600ms");
  r.advance(200);
  assert.equal(calls, 1);
});

test("finger held counts as active", () => {
  const r = idle();
  let calls = 0;
  r.fire("touchstart");
  r.PR.whenScrollIdle(() => calls++);
  r.advance(2000);
  assert.equal(calls, 0, "手指没抬起，不重渲染");
  r.fire("touchend");
  r.advance(599);
  assert.equal(calls, 0);
  r.advance(1);
  assert.equal(calls, 1);
});

test("touchcancel releases the finger too", () => {
  const r = idle();
  let calls = 0;
  r.fire("touchstart");
  r.PR.whenScrollIdle(() => calls++);
  r.fire("touchcancel");
  r.advance(600);
  assert.equal(calls, 1);
});

/* main.js 的 remote 处理：真 PR.on/emit，其余渲染函数只记次数 */
function readerMain() {
  const box = sandbox();
  const subs = {}, calls = { rerender: 0, job: 0, toast: 0, flash: 0, marks: 0 };
  const el = { innerHTML: "", classList: { contains: () => false, remove() {} }, style: {} };
  const PR = {
    state: { paper: { meta: { title_zh: "论文" }, blocks: [] }, discussion: { entries: [] }, job: null },
    on: (ev, fn) => (subs[ev] = subs[ev] || []).push(fn),
    emit: (ev, data) => (subs[ev] || []).forEach((fn) => fn(data)),
    throttle: (fn) => fn, debounce: (fn) => fn,
    libraryNav: { readerBack() {} }, applyPrefs() {},
    load: () => new Promise(() => {}),  // 启动流程与此无关
    noteMedia: { isRenaming: () => false },
    $: () => el, titleHtml: (s) => s, t: (s) => s, esc: (s) => s, plain: (s) => s,
    ls: { set() {}, get: (k, d) => d },
    rerenderKeepingPlace: () => calls.rerender++,
    renderJobState: () => calls.job++,
    applyMarks: () => calls.marks++, renderMargin() {},
    notesPanelOpen: () => false, renderDrawer() {},
    flashCard: () => calls.flash++, toast: () => calls.toast++,
    anchorOfEntry: () => "x", jumpTo() {},
  };
  box.context.window.PR = PR;
  box.context.document = { body: el, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(READER, "scroll-idle.js"), "utf8"), box.context);
  vm.runInNewContext(fs.readFileSync(path.join(READER, "main.js"), "utf8"), box.context);
  return { PR, calls, ...box };
}

test("remote changes are merged", () => {
  const r = readerMain();
  r.fire("scroll");
  r.PR.emit("remote", ["paper"]);
  r.PR.state.discussion.entries = [{ id: "e1", title: "新讨论" }];
  r.PR.emit("remote", ["discussion"]);
  r.PR.emit("remote", ["job"]);
  assert.equal(r.calls.job, 1, "进度条即时更新");
  assert.equal(r.calls.rerender, 0, "滑动中不重渲染");
  r.advance(600);
  assert.equal(r.calls.rerender, 1, "三次变化合并成一次重渲染");
  assert.equal(r.calls.marks, 1);
  assert.ok(r.calls.toast + r.calls.flash > 0, "新讨论仍然提示");
  r.advance(5000);
  assert.equal(r.calls.rerender, 1);
});

test("remote changes apply at once when not scrolling", () => {
  const r = readerMain();
  r.PR.emit("remote", ["paper"]);
  assert.equal(r.calls.rerender, 1);
  r.PR.emit("remote", ["paper"]);
  assert.equal(r.calls.rerender, 2);
});
