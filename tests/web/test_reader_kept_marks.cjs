const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const READER = path.join(__dirname, "../../easyread/web/js/reader");
const NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };

/* 小型树状假 DOM：够 reconcile.js 的增量比对和 anchor.js 的 applyMarks 用（拆包、normalize、splitText、TreeWalker） */
class Text {
  constructor(data) { this.nodeType = 3; this.data = data; this.parentNode = null; }
  get length() { return this.data.length; }
  get parentElement() { return this.parentNode; }
  get outerHTML() { return this.data; }
  get textContent() { return this.data; }
  splitText(offset) {
    const rest = new Text(this.data.slice(offset));
    this.data = this.data.slice(0, offset);
    this.parentNode.insertBefore(rest, this.nextSibling());
    return rest;
  }
  nextSibling() { const list = this.parentNode.childNodes; return list[list.indexOf(this) + 1] || null; }
}

function matches(el, selector) {
  return selector.split(",").some((one) => {
    const parts = one.trim().match(/^([a-z0-9]*)((?:[.#][\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i);
    if (!parts || (parts[1] && parts[1].toUpperCase() !== el.tagName)) return false;
    return (parts[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || []).every((p) => {
      if (p[0] === ".") return el.classList.contains(p.slice(1));
      if (p[0] === "#") return el.id === p.slice(1);
      const [, name, value] = p.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      return value == null ? el.attrs.has(name) : el.attrs.get(name) === value;
    });
  });
}

class Element {
  constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.childNodes = []; this.parentNode = null; }
  get parentElement() { return this.parentNode; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get id() { return this.attrs.get("id") || ""; }
  get className() { return this.attrs.get("class") || ""; }
  get classList() {
    const list = () => this.className.split(" ").filter(Boolean);
    const set = (items) => this.attrs.set("class", items.join(" "));
    return {
      contains: (c) => list().includes(c),
      add: (...cs) => set([...new Set(list().concat(cs))]),
      remove: (...cs) => set(list().filter((c) => !cs.includes(c))),
    };
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(""); }
  get outerHTML() {
    const attrs = Array.from(this.attrs).map(([k, v]) => " " + k + '="' + v + '"').join("");
    const tag = this.tagName.toLowerCase();
    return "<" + tag + attrs + ">" + this.childNodes.map((n) => n.outerHTML).join("") + "</" + tag + ">";
  }
  set innerHTML(html) { this.childNodes.forEach((n) => (n.parentNode = null)); this.childNodes = []; parse(html).forEach((n) => this.appendChild(n)); }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(...nodes) { const parent = this.parentNode; nodes.forEach((n) => parent.insertBefore(n, this)); this.remove(); }
  normalize() {
    const merged = [];
    for (const n of this.childNodes) {
      if (n.nodeType === 1) { n.normalize(); merged.push(n); continue; }
      const prev = merged[merged.length - 1];
      if (!n.data) n.parentNode = null;
      else if (prev && prev.nodeType === 3) { prev.data += n.data; n.parentNode = null; } else merged.push(n);
    }
    this.childNodes = merged;
  }
  closest(selector) { for (let el = this; el; el = el.parentNode) if (matches(el, selector)) return el; return null; }
  descendants() { return this.childNodes.flatMap((n) => (n.nodeType === 1 ? [n, ...n.descendants()] : [])); }
  querySelectorAll(selector) { return this.descendants().filter((el) => matches(el, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function parse(html) {
  const root = new Element("template");
  let cur = root;
  for (const m of html.matchAll(/<(\/?)(\w+)([^>]*)>|([^<]+)/g)) {
    if (m[4]) { cur.appendChild(new Text(m[4])); continue; }
    if (m[1]) { cur = cur.parentNode; continue; }
    const el = new Element(m[2]);
    for (const a of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) el.setAttribute(a[1], a[2]);
    cur.appendChild(el);
    cur = el;
  }
  return root.childNodes.slice();
}

function textWalker(root, filter) {
  const all = [];
  (function walk(el) { el.childNodes.forEach((n) => (n.nodeType === 3 ? all.push(n) : walk(n))); })(root);
  const accepted = all.filter((n) => filter.acceptNode(n) === NodeFilter.FILTER_ACCEPT);
  return { nextNode: () => accepted.shift() || null };
}

function reader() {
  const body = new Element("body"), paper = new Element("div");
  paper.setAttribute("id", "paper");
  body.appendChild(paper);
  const selbar = { addEventListener() {}, classList: { remove() {} } };
  const S = { reader: { notes: {} }, discussion: { entries: [] } };
  const PR = {
    state: S, debounce: (fn) => fn, noteEl: (zh) => zh,
    myNotes: () => Object.values(S.reader.notes).filter((n) => !n.deleted),
    $: (sel) => (sel === "#selbar" ? selbar : body.querySelector(sel)),
    $$: (sel, scope) => (scope || body).querySelectorAll(sel),
  };
  const document = {
    createElement: (tag) => new Element(tag),
    createTreeWalker: (root, what, filter) => textWalker(root, filter),
    getElementById: (id) => body.querySelector("#" + id),
    addEventListener() {},
  };
  const context = { window: { PR }, document, NodeFilter, CSS: { escape: (s) => s }, getSelection: () => null };
  ["reconcile.js", "anchor.js"].forEach((file) => vm.runInNewContext(fs.readFileSync(path.join(READER, file), "utf8"), context));
  PR.parseTopLevel = (html) => parse(html).filter((n) => n.nodeType === 1);
  return { PR, S, paper };
}

const blk = (id, text) => '<section class="blk blk-para" id="b-' + id + '" data-id="' + id + '"><div class="zh" data-key="' + id + '">' + text + "</div></section>";
const marksIn = (node) => node.querySelectorAll("mark.hl");

function markedReader() {
  const r = reader();
  r.S.reader.notes.n1 = { id: "n1", anchor: "a", key: "a", quote: "beta", kind: "highlight", color: "yellow" };
  r.PR.reconcilePaper(r.paper, blk("a", "Alpha beta gamma") + blk("b", "B"));
  r.PR.applyMarks();
  return r;
}

test("deleted highlight disappears from a block kept by incremental render", () => {
  const { PR, S, paper } = markedReader();
  const kept = paper.children[0];
  assert.equal(marksIn(kept).length, 1);
  S.reader.notes.n1.deleted = true;
  const info = PR.reconcilePaper(paper, blk("a", "Alpha beta gamma") + blk("b", "B2"));
  assert.equal(info.incremental, true);
  assert.equal(paper.children[0], kept);
  assert.ok(!info.replaced.includes(kept));
  PR.applyMarks();
  assert.equal(marksIn(kept).length, 0);
  const zh = kept.querySelector(".zh");
  assert.equal(zh.childNodes.length, 1);
  assert.equal(zh.textContent, "Alpha beta gamma");
});

test("re-applying marks on a kept block leaves exactly one unnested mark", () => {
  const { PR, paper } = markedReader();
  const kept = paper.children[0];
  PR.reconcilePaper(paper, blk("a", "Alpha beta gamma") + blk("b", "B2"));
  PR.applyMarks();
  PR.applyMarks();
  const marks = marksIn(kept);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].parentNode, kept.querySelector(".zh"));
  assert.equal(marks[0].textContent, "beta");
  assert.equal(kept.querySelector(".zh").textContent, "Alpha beta gamma");
});

test("changed highlight color is reflected on a kept block", () => {
  const { PR, S, paper } = markedReader();
  const kept = paper.children[0];
  S.reader.notes.n1.color = "pink";
  PR.reconcilePaper(paper, blk("a", "Alpha beta gamma") + blk("b", "B2"));
  PR.applyMarks();
  const marks = marksIn(kept);
  assert.equal(marks.length, 1);
  assert.ok(marks[0].classList.contains("c-pink"));
  assert.ok(!marks[0].classList.contains("c-yellow"));
});
