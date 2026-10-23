/* 整页重排时只换源码变了的顶层块：其余节点原样留着，省掉整页重建 DOM 和重排。
   比对用渲染时记下的源串，不读当前 DOM（批注高亮、句子对齐会在渲染后改 DOM）。 */
(function (PR) {
  "use strict";
  const STATE_CLASSES = ["show-en", "notes-open", "current"];
  const records = new WeakMap();  // 顶层节点 → { src, key }
  const lastHtml = new WeakMap();  // 容器 → 上次整串

  // 单独成函数，测试里换成假 DOM 的解析
  PR.parseTopLevel = function (html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    return Array.from(template.content.children);
  };

  function keyer() {
    const counts = {};
    return function (node) {
      const id = node.getAttribute("data-id");
      const base = id != null ? "id:" + id : node.tagName + "." + node.className;
      const n = (counts[base] = (counts[base] || 0) + 1) - 1;
      return id != null && n === 0 ? base : base + "#" + n;
    };
  }

  function remember(nodes) {
    const keyOf = keyer();
    nodes.forEach((node) => records.set(node, { src: node.outerHTML, key: keyOf(node) }));
  }

  function fullRender(container, html) {
    container.innerHTML = html;
    const nodes = Array.from(container.children);
    remember(nodes);
    return { incremental: false, replaced: nodes, kept: 0 };
  }

  function oldByKey(container) {
    const map = new Map();
    Array.from(container.children).forEach((node) => {
      const rec = records.get(node);
      if (rec) map.set(rec.key, node);
    });
    return map;
  }

  // 新旧逐个对上：源串相同留旧节点，否则用新节点并带上展开对照、笔记、当前块这些状态
  function plan(container, html) {
    const old = oldByKey(container);
    const keyOf = keyer();
    const replaced = [];
    const wanted = PR.parseTopLevel(html).map((fresh) => {
      const key = keyOf(fresh);
      const src = fresh.outerHTML;
      const prev = old.get(key);
      if (prev && records.get(prev).src === src) return prev;
      if (prev) STATE_CLASSES.forEach((c) => prev.classList.contains(c) && fresh.classList.add(c));
      records.set(fresh, { src, key });
      replaced.push(fresh);
      return fresh;
    });
    return { wanted, replaced };
  }

  // 先删掉不要的，留下的旧节点相对顺序不变，再按序插入新节点，避免后面的块被逐个挪动
  function apply(container, wanted) {
    const keep = new Set(wanted);
    Array.from(container.children).forEach((node) => keep.has(node) || node.remove());
    wanted.forEach((node, i) => {
      const at = container.children[i] || null;
      if (at !== node) container.insertBefore(node, at);
    });
  }

  // renderBlock 绕过整页重排单独换块：登记新节点，并作废“整串没变”的捷径，下次重排才会对照到它
  PR.adoptPaperNode = function (old, fresh) {
    const rec = records.get(old);
    const id = fresh.getAttribute("data-id");
    records.set(fresh, { src: fresh.outerHTML, key: rec ? rec.key : "id:" + id });
    if (old.parentNode) lastHtml.delete(old.parentNode);
  };

  PR.reconcilePaper = function (container, html) {
    if (!container.children.length) {
      lastHtml.set(container, html);
      return fullRender(container, html);
    }
    if (lastHtml.get(container) === html) return { incremental: true, replaced: [], kept: container.children.length };
    lastHtml.set(container, html);
    const { wanted, replaced } = plan(container, html);
    apply(container, wanted);
    return { incremental: true, replaced, kept: wanted.length - replaced.length };
  };
})(window.PR);
