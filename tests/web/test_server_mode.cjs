const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { page } = require("../helpers/library_page.cjs");

const UNAVAILABLE = "Web 端不可用，请在桌面 App 中操作";
const source = file => fs.readFileSync(path.join(__dirname, "../../easyread/web/js/", file), "utf8");

function fakeNode() {
  const events = {};
  return {
    events, innerHTML: "", value: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(name, fn) { events[name] = fn; },
    querySelector() { return this.inner || (this.inner = fakeNode()); },
  };
}

// 详情菜单、帮助、导入、设置四个模块各自装进最小沙箱；serverMode 在点击/渲染时才读，所以先加载后改也行
function modules(serverMode) {
  const nodes = new Map(), calls = [];
  const $ = sel => { if (!nodes.has(sel)) nodes.set(sel, fakeNode()); return nodes.get(sel); };
  const paper = { id: "p1", title_en: "Paper", tags: [] };
  const PR = {
    serverMode, $, $$: () => [], el: () => fakeNode(), icon: () => "", logo: () => "",
    t: (text, vars = {}) => text.replace(/\{(\w+)\}/g, (m, key) => vars[key] ?? m),
    esc: text => String(text ?? ""), ls: { get: (key, fallback) => fallback, set() {} },
    targetName: () => "中文", opt: () => "", TARGETS: [], target: "zh",
    toast: html => calls.push(["toast", html]),
    menu: (where, items) => calls.push(["menu", items]),
    openZotero: () => calls.push(["openZotero"]), openFolderImport: () => calls.push(["openFolderImport"]),
    api: async url => { calls.push(["api", url]); return url.endsWith("location") ? { path: "/srv/easyread", candidates: [] } : {}; },
    lib: { engine: "none", byId: () => paper, side: { pinned: [] }, catMenuItems: () => [], load() {} },
    settingsTabs: {}, settingsRender() {},
  };
  const context = { window: { PR, addEventListener() {} }, document: { addEventListener() {}, activeElement: fakeNode() }, setTimeout: () => 0, clearTimeout() {} };
  for (const file of ["library/detail.js", "library/help.js", "library/import.js", "library/settings-cloud.js"]) vm.runInNewContext(source(file), context);
  const menuLabels = () => { calls.length = 0; PR.rowMenu("p1", null); return calls[0][1].filter(it => it !== "-").map(it => it.label); };
  const helpHtml = () => { PR.openHelp(); return $("#textDlg").querySelector().innerHTML; };
  const importClick = id => $("#importDlg").events.click({ target: { closest: sel => sel.split(/,\s*/).includes("#" + id) ? {} : null } });
  const settingsHtml = async () => {
    PR.settingsState = { tab: "cloud" };
    PR.settingsTabs.cloud.render(PR.settingsState);
    for (let n = 0; n < 5; n++) await Promise.resolve();
    return PR.settingsTabs.cloud.render(PR.settingsState);
  };
  return { PR, calls, menuLabels, helpHtml, importClick, settingsHtml };
}

test("library load exposes server mode from /api/library", async () => {
  for (const [mode, expected] of [["server", true], ["desktop", false], [undefined, false]]) {
    const p = page();
    p.setLibraryRead(() => ({ items: [], engine: "none", token: "t", first_run: false, version: "1", mode }));
    p.library([]);
    assert.equal(p.PR.serverMode, false);
    await p.boot();
    assert.equal(p.PR.serverMode, expected);
  }
});

test("server mode hides reveal entries", async () => {
  const m = modules(true);
  assert.ok(!m.menuLabels().includes("打开所在文件夹"));
  assert.doesNotMatch(m.helpHtml(), /data-help-do="library"/);
  assert.match(m.helpHtml(), /data-help-do="log"/);
  const html = await m.settingsHtml();
  assert.doesNotMatch(html, /data-cloud="(reveal|custom|restart|copy|use|merge|refresh)"/);
  assert.match(html, /文献库位置：\/srv\/easyread（Web 端不可更改）/);
});

test("server mode folder and zotero buttons toast", () => {
  const m = modules(true);
  for (const id of ["folderGo", "zoteroGo"]) {
    m.calls.length = 0;
    m.importClick(id);
    assert.deepEqual(m.calls, [["toast", UNAVAILABLE]]);
  }
});

test("desktop mode keeps entries", async () => {
  const m = modules(false);
  assert.ok(m.menuLabels().includes("打开所在文件夹"));
  assert.match(m.helpHtml(), /data-help-do="library"/);
  const html = await m.settingsHtml();
  assert.match(html, /data-cloud="reveal"/);
  assert.match(html, /data-cloud="custom"/);
  assert.doesNotMatch(html, /Web 端不可更改/);
  m.calls.length = 0; m.importClick("folderGo");
  assert.deepEqual(m.calls, [["openFolderImport"]]);
  m.calls.length = 0; m.importClick("zoteroGo");
  assert.deepEqual(m.calls, [["openZotero"]]);
});

function utilApi(status, body) {
  const PR = { t: (text, vars = {}) => text.replace(/\{(\w+)\}/g, (m, key) => vars[key] ?? m) };
  const fetch = async () => ({ ok: status < 400, status, json: async () => body });
  const context = { window: { PR, addEventListener() {} }, document: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, fetch, Blob, ArrayBuffer };
  vm.runInNewContext(source("common/util.js"), context);
  return PR.api;
}

test("web_unavailable error surfaces message", async () => {
  const api = utilApi(403, { error: "web_unavailable", message: UNAVAILABLE });
  await assert.rejects(api("/api/library/reveal", { method: "POST", body: {} }), error => error.message === UNAVAILABLE);
});

test("other api errors keep using the error field", async () => {
  const api = utilApi(400, { error: "bad path", message: "ignored" });
  await assert.rejects(api("/api/x", { method: "POST", body: {} }), error => error.message === "bad path");
  const empty = utilApi(500, {});
  await assert.rejects(empty("/api/x"), error => error.message === "请求失败 500");
});
