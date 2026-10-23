const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const READER = path.join(__dirname, "../../easyread/web/js");
const load = (rel, context) => vm.runInNewContext(fs.readFileSync(path.join(READER, rel), "utf8"), context);

/* 最小假 DOM：只认顶层元素，outerHTML 记成源串（测试里可以改它模拟渲染后的 DOM 变动） */
function fakeElement(source) {
  const open = source.match(/^<(\w+)([^>]*)>/);
  const attr = (name) => { const m = open[2].match(new RegExp(name + '="([^"]*)"')); return m ? m[1] : null; };
  const classes = new Set((attr("class") || "").split(" ").filter(Boolean));
  const el = {
    tagName: open[1].toUpperCase(), outerHTML: source, parent: null,
    get className() { return Array.from(classes).join(" "); },
    get id() { return attr("id") || ""; },
    get textContent() { return source.replace(/<[^>]*>/g, ""); },
    getAttribute: (name) => attr(name),
    classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), toggle() {} },
    remove() { if (el.parent) el.parent.removeChild(el); },
    getBoundingClientRect: () => ({ top: 0 }),
  };
  return el;
}

function parseTopLevel(html) {
  const out = [];
  let depth = 0, start = 0;
  for (const m of html.matchAll(/<(\/?)(\w+)[^>]*>/g)) {
    if (/^(img|br|input)$/i.test(m[2])) continue;
    if (!m[1]) { if (depth++ === 0) start = m.index; continue; }
    if (--depth === 0) out.push(fakeElement(html.slice(start, m.index + m[0].length)));
  }
  return out;
}

function fakeContainer() {
  const box = {
    children: [], writes: 0,
    set innerHTML(html) { box.writes++; box.children.forEach((c) => (c.parent = null)); box.children = []; parseTopLevel(html).forEach((c) => box.insertBefore(c, null)); },
    removeChild(node) { box.children.splice(box.children.indexOf(node), 1); node.parent = null; },
    insertBefore(node, ref) {
      if (node.parent) node.parent.removeChild(node);
      const at = ref ? box.children.indexOf(ref) : box.children.length;
      box.children.splice(at, 0, node);
      node.parent = box;
    },
  };
  return box;
}

function reconciler() {
  const PR = {};
  load("reader/reconcile.js", { window: { PR }, document: {} });
  PR.parseTopLevel = parseTopLevel;
  return PR;
}

const blk = (id, text) => '<section class="blk blk-para" id="b-' + id + '" data-id="' + id + '"><div class="zh">' + text + "</div></section>";
const texts = (box) => box.children.map((c) => c.textContent);

test("first render uses full html", () => {
  const PR = reconciler(), box = fakeContainer();
  const info = PR.reconcilePaper(box, blk("a", "A") + blk("b", "B"));
  assert.equal(info.incremental, false);
  assert.equal(box.children.length, 2);
  assert.equal(info.replaced.length, 2);
  assert.equal(box.writes, 1);
});

test("identical html touches nothing", () => {
  const PR = reconciler(), box = fakeContainer();
  const html = blk("a", "A") + blk("b", "B");
  PR.reconcilePaper(box, html);
  const before = box.children.slice();
  const info = PR.reconcilePaper(box, html);
  assert.equal(info.incremental, true);
  assert.equal(info.replaced.length, 0);
  assert.equal(info.kept, 2);
  before.forEach((node, i) => assert.equal(box.children[i], node));
  assert.equal(box.writes, 1);
});

test("only changed block is replaced", () => {
  const PR = reconciler(), box = fakeContainer();
  PR.reconcilePaper(box, blk("a", "A") + blk("b", "B") + blk("c", "C"));
  const [a, b, c] = box.children;
  const info = PR.reconcilePaper(box, blk("a", "A") + blk("b", "B2") + blk("c", "C"));
  assert.equal(box.children[0], a);
  assert.notEqual(box.children[1], b);
  assert.equal(box.children[2], c);
  assert.equal(info.replaced.length, 1);
  assert.equal(info.replaced[0], box.children[1]);
  assert.equal(info.kept, 2);
  assert.deepEqual(texts(box), ["A", "B2", "C"]);
});

test("state classes carry over to replaced block", () => {
  const PR = reconciler(), box = fakeContainer();
  PR.reconcilePaper(box, blk("a", "A") + blk("b", "B"));
  ["show-en", "notes-open", "current"].forEach((c) => box.children[1].classList.add(c));
  PR.reconcilePaper(box, blk("a", "A") + blk("b", "B2"));
  const fresh = box.children[1];
  assert.equal(fresh.textContent, "B2");
  ["show-en", "notes-open", "current"].forEach((c) => assert.ok(fresh.classList.contains(c), c));
});

test("dom mutated by marks does not fool comparison", () => {
  const PR = reconciler(), box = fakeContainer();
  PR.reconcilePaper(box, blk("a", "A") + blk("b", "B"));
  const a = box.children[0];
  a.outerHTML = a.outerHTML.replace("A", "<mark>A</mark>");
  const info = PR.reconcilePaper(box, blk("a", "A") + blk("b", "B2"));
  assert.equal(box.children[0], a);
  assert.equal(info.replaced.length, 1);
});

test("keyless siblings reorder correctly", () => {
  const PR = reconciler(), box = fakeContainer();
  const gap = (t) => '<div class="pending-pages gap">' + t + "</div>";
  PR.reconcilePaper(box, blk("a", "A") + gap("g1") + blk("b", "B") + gap("g2"));
  const info = PR.reconcilePaper(box, blk("a", "A") + gap("g2") + blk("b", "B") + gap("g1"));
  assert.equal(info.replaced.length, 2);
  assert.deepEqual(texts(box), ["A", "g2", "B", "g1"]);
});

test("inserted and removed blocks", () => {
  const PR = reconciler(), box = fakeContainer();
  PR.reconcilePaper(box, blk("a", "A") + blk("b", "B") + blk("c", "C"));
  const [a, , c] = box.children;
  const info = PR.reconcilePaper(box, blk("a", "A") + blk("c", "C") + blk("d", "D"));
  assert.deepEqual(texts(box), ["A", "C", "D"]);
  assert.equal(box.children[0], a);
  assert.equal(box.children[1], c);
  assert.equal(info.replaced.length, 1);
  assert.equal(info.kept, 2);
});

test("moved block keeps its node and order follows new html", () => {
  const PR = reconciler(), box = fakeContainer();
  PR.reconcilePaper(box, blk("a", "A") + blk("b", "B") + blk("c", "C"));
  const [a, b, c] = box.children;
  PR.reconcilePaper(box, blk("c", "C") + blk("a", "A") + blk("b", "B"));
  assert.deepEqual(box.children, [c, a, b]);
});

test("node replaced outside reconcile is replaced again on next change", () => {
  const PR = reconciler(), box = fakeContainer();
  PR.reconcilePaper(box, blk("a", "A") + blk("b", "B"));
  const stranger = fakeElement(blk("a", "A"));
  box.insertBefore(stranger, box.children[0]);
  box.children[1].remove();
  PR.reconcilePaper(box, blk("a", "A") + blk("b", "B2"));
  assert.deepEqual(texts(box), ["A", "B2"]);
  assert.notEqual(box.children[0], stranger);
});

/* renderBlock 单独换块后，回到原来那串也要重排；没变的块保住展开状态 */
test("block swapped by renderBlock is reconciled even when html returns to the old string", () => {
  const PR = reconciler(), box = fakeContainer();
  PR.reconcilePaper(box, blk("a", "T") + blk("b", "B"));
  const old = box.children[0];
  old.parentNode = box;
  const edited = fakeElement(blk("a", "X"));
  PR.adoptPaperNode(old, edited);
  edited.classList.add("show-en");
  box.insertBefore(edited, old);
  old.remove();
  PR.reconcilePaper(box, blk("a", "T") + blk("b", "B"));
  assert.deepEqual(texts(box), ["T", "B"]);
  assert.ok(box.children[0].classList.contains("show-en"));
});

test("block swapped by renderBlock with unchanged source is kept", () => {
  const PR = reconciler(), box = fakeContainer();
  PR.reconcilePaper(box, blk("a", "A") + blk("b", "B"));
  const old = box.children[0];
  old.parentNode = box;
  const same = fakeElement(blk("a", "A"));
  PR.adoptPaperNode(old, same);
  box.insertBefore(same, old);
  old.remove();
  const info = PR.reconcilePaper(box, blk("a", "A") + blk("b", "B2"));
  assert.equal(box.children[0], same);
  assert.equal(info.replaced.length, 1);
});

/* 离线导出版：#pr-data 里带数据，store 走 static 模式，整页重排也只换变了的块 */
async function staticReader(paper) {
  const paperEl = fakeContainer();
  const classList = { toggle() {} };
  const document = {
    body: { classList }, documentElement: { dataset: {} },
    getElementById: (id) => (id === "pr-data" ? { textContent: JSON.stringify({ paper, reader: {} }) } : id === "paper" ? paperEl : paperEl.children.find((c) => c.id === id) || null),
  };
  const PR = {
    t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s), uid: () => "client", nowIso: () => "2026-10-23T00:00:00Z",
    on() {}, emit(name, info) { if (name === "rendered") PR.lastInfo = info; },
    ls: { get: (key, fallback) => fallback, set: () => true },
    esc: String, md: String, hashText: String, target: "zh", targetName: String, pageCapHtml: () => "",
    $: (sel) => (sel === "#paper" ? paperEl : null),
  };
  const context = { window: { PR, addEventListener() {}, scrollBy() {} }, location: { pathname: "" }, document, setTimeout() {}, clearTimeout() {}, URL };
  load("reader/store.js", context);
  load("common/markup.js", context);
  load("reader/reconcile.js", context);
  load("reader/render.js", context);
  PR.parseTopLevel = parseTopLevel;
  await PR.load();
  return { PR, paperEl };
}

test("static export mode still reconciles", async () => {
  const blocks = [{ id: "p1", type: "para", zh: "一" }, { id: "p2", type: "para", zh: "二" }, { id: "p3", type: "para", zh: "三" }];
  const { PR, paperEl } = await staticReader({ meta: { source_sha256: "abc", title_zh: "T" }, blocks });
  assert.equal(PR.store.mode, "static");
  PR.rerenderKeepingPlace();
  assert.equal(PR.lastInfo.incremental, false);
  const before = paperEl.children.slice();
  PR.state.paper.blocks[1].zh = "二改";
  PR.rerenderKeepingPlace();
  assert.equal(PR.lastInfo.incremental, true);
  assert.equal(PR.lastInfo.replaced.length, 1);
  assert.equal(PR.lastInfo.replaced[0].getAttribute("data-id"), "p2");
  const changed = paperEl.children.findIndex((c) => c.getAttribute("data-id") === "p2");
  paperEl.children.forEach((node, i) => (i === changed ? assert.notEqual(node, before[i]) : assert.equal(node, before[i])));
  assert.equal(paperEl.writes, 1);
});
