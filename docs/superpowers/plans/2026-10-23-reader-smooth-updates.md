# 阅读页后台更新不卡顿 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后台翻译写入时，阅读页滑动不顿挫，更新到达后阅读位置和展开状态不丢。

**Architecture:** 两层改动。①滑动期间推迟远端更新：新文件 `scroll-idle.js` 跟踪滑动/触摸，`main.js` 合并 `remote` 事件，等空闲后再执行；②增量渲染：新文件 `reconcile.js`，`renderPaper()` 照旧生成整篇 HTML，第二次起只替换源字符串变化的顶层块。最后审计 `rendered` 监听器，保证对保留节点重复执行无副作用。

**Tech Stack:** 原生 JS（`PR.*` 命名空间）、`node --test` + vm 沙箱、Playwright MCP（性能验证）。

**Spec:** `docs/superpowers/specs/2026-10-23-reader-smooth-updates.md`

## Global Constraints

- 不新增依赖，不引入虚拟 DOM 库；后端协议不变。
- `SCROLL_IDLE_MS = 600`。
- 保留类名清单：`show-en`、`notes-open`、`current`（与 `render.js` 的 `PR.renderBlock` 一致）。
- 新 JS 文件在 `easyread/web/reader.html` 里以 `<script src="/web/js/reader/<name>.js"></script>` 引入（离线导出 `easyread/export/build.py` 会自动内联这些标签）；`scroll-idle.js` 在 `main.js` 之前，`reconcile.js` 在 `render.js` 之前。
- 单函数 ≤ 40 行；新文件 ≤ 300 行；`render.js` 不得变长超过 10 行。
- 中文短注释，只写原因。
- 桌面版、浏览器、离线导出行为一致；`python -m unittest discover tests` 与 `node --test tests/web/test_*.cjs tests/desktop/test_*.cjs` 全过。

## Review Focus

1. 手指按住不动（`touchstart` 后无 `touchmove`）超过 600ms：仍算"在滑动"，不能执行更新 → Task 1 测试。
2. 推迟期间连续来了 `paper`、`discussion`、`job` 多次变化：空闲后只执行一次 `after()`，且 `changed` 是并集（`announceNew` 仍会触发）→ Task 1 测试。
3. 无 `data-id` 的同类节点（例如两个缺页提示 `.gap`）顺序变化：不能错误保留 → Task 2 测试。
4. 删除批注后增量渲染：保留节点上的旧高亮被 `applyMarks()` 清掉 → Task 3 测试。
5. 离线导出页（`#pr-data` 静态模式）没有轮询，但编辑保存仍走 `rerenderKeepingPlace` → Task 2 测试覆盖静态模式下的增量渲染。

---

### Task 1: 滑动期间推迟远端更新

**Files:**
- Create: `easyread/web/js/reader/scroll-idle.js`
- Modify: `easyread/web/js/reader/main.js:68-96`（`remote` 处理）
- Modify: `easyread/web/reader.html`（在 `main.js` 之前加 `scroll-idle.js`）
- Test: `tests/web/test_reader_scroll_idle.cjs`（新建）

**Interfaces:**
- Produces: `PR.scrollActivity = { isActive(now?: number): boolean }`；`PR.whenScrollIdle(fn: () => void): void`，空闲时同步执行；忙时只在空闲后执行最后登记的那一次（调用方负责合并参数）。可注入时钟以便测试：`PR.scrollActivity._now`（默认 `performance.now`），实现时选择对测试最自然的方式。

- [ ] **Step 1: 写失败测试** `tests/web/test_reader_scroll_idle.cjs`（vm 沙箱 + 假时钟、假计时器，写法参照 `tests/web/test_reader_progress.cjs`）：
  - `runs immediately when idle`：从未滑动 → `whenScrollIdle(fn)` 同步调用 `fn` 一次。
  - `defers while scrolling and runs once after 600ms idle`：派发 `scroll` → 立即调用两次 `whenScrollIdle` → `fn` 未执行；时钟推进 599ms 仍未执行；推进到 600ms 后恰好执行一次。
  - `finger held counts as active`：`touchstart` 后推进 2000ms 无其他事件 → 不执行；`touchend` 后再推进 600ms → 执行一次。
  - `remote changes are merged`：加载 `main.js` 的 remote 处理（或抽出的可测函数），滑动中依次 emit `remote` `["paper"]`、`["discussion"]`、`["job"]`，空闲后断言 `PR.rerenderKeepingPlace` 调用 1 次，`announceNew` 路径被触发（`PR.toast` 或 `PR.flashCard` 有调用），`PR.renderJobState` 每次 emit 都立即调用（共 1 次，因为只有一次含 job）。
- [ ] **Step 2: 运行确认失败** `node --test tests/web/test_reader_scroll_idle.cjs`。
- [ ] **Step 3: 实现**：事件监听全部 `{ passive: true }` 挂在 `window`；`main.js` 里用一个 `Set` 合并待处理的 `changed`，经 `PR.whenScrollIdle` 再经现有 `busy()` 轮询后执行一次 `after(changedArray)`，执行后清空集合；`renderJobState()` 保持即时。
- [ ] **Step 4: 运行确认通过**，再跑全量 node 测试。
- [ ] **Step 5: Commit** `perf(reader): defer remote re-render until scrolling stops`

### Task 2: 增量渲染顶层块

**Files:**
- Create: `easyread/web/js/reader/reconcile.js`
- Modify: `easyread/web/js/reader/render.js:223-245`（`PR.renderPaper` 里 `innerHTML` 赋值处改为调用 `PR.reconcilePaper`；`PR.emit("rendered", info)`）
- Modify: `easyread/web/reader.html`（在 `render.js` 之前加 `reconcile.js`）
- Test: `tests/web/test_reader_reconcile.cjs`（新建）

**Interfaces:**
- Produces: `PR.reconcilePaper(container: Element, html: string) -> { incremental: boolean, replaced: Element[], kept: number }`。首次（容器无子节点）用 `innerHTML`，返回 `incremental: false`、`replaced` 为全部子节点。之后：整串与上次相同 → `{ incremental: true, replaced: [], kept: n }` 且不碰 DOM。每个顶层子节点的源字符串存在模块内 `WeakMap`；节点键：有 `data-id` 用 `"id:" + data-id`，否则 `tagName + "." + className + "#" + 同键序号`。
- `PR.renderPaper()` 末尾 `PR.emit("rendered", info)`，`info` 即上面的返回值。

- [ ] **Step 1: 写失败测试** `tests/web/test_reader_reconcile.cjs`（用 node 自带能力或仓库现有的假 DOM 写法；如果现有 helper 不支持 `<template>`，在测试里实现最小的假 DOM，或用 `tests/helpers` 里已有工具，不新增依赖）：
  - `first render uses full html`：空容器 → 返回 `incremental:false`，子节点数正确。
  - `identical html touches nothing`：同一串渲染两次 → 第二次 `replaced.length === 0`，节点对象全同（`===`）。
  - `only changed block is replaced`：3 个块，第 2 块文字变化 → 第 1、3 块节点 `===` 旧节点，第 2 块是新节点，`replaced.length === 1`。
  - `state classes carry over to replaced block`：旧第 2 块有 `show-en`、`notes-open`、`current` → 新节点同样有这三个类。
  - `dom mutated by marks does not fool comparison`：渲染后往第 1 块里手动插入一个 `<mark>` → 用相同源串再渲染 → 第 1 块被保留（比对用源字符串而非当前 DOM）。
  - `keyless siblings reorder correctly`：两个无 `data-id` 的 `.gap` 节点内容互换 → 两个都被替换（或按键正确对应），最终 DOM 文本顺序与新串一致。
  - `inserted and removed blocks`：新串插入一个块、删除一个块 → 最终子节点顺序与新串一致，未变块保留。
  - `static export mode still reconciles`：在 `#pr-data` 静态模式下调用 `PR.rerenderKeepingPlace()` 两次（第二次改一块）→ 只替换那一块。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现** `reconcile.js` 并接入 `renderPaper`；`rerenderKeepingPlace` 的锚点修正保持不变。
- [ ] **Step 4: 运行确认通过**，跑全量 node + Python 测试（现有阅读页测试若断言了 `innerHTML` 整体替换，按新行为更新断言并在报告中逐条说明）。
- [ ] **Step 5: Commit** `perf(reader): replace only changed top-level blocks on re-render`

### Task 3: `rendered` 监听器幂等性

**Files:**
- Modify（按审计结果，只改不幂等的）：`easyread/web/js/reader/pdf-text.js:85`、`reading-language.js:132`、`note-media-drag.js:20`、`find.js:71`、`pageview.js:201`；以及 `main.js` remote `after()` 里的 `PR.applyMarks()`、`PR.renderMargin()` 的调用方
- Test: `tests/web/test_reader_reconcile.cjs`（追加）或各模块已有测试文件

**Interfaces:**
- Consumes: `rendered` 事件参数 `{ incremental, replaced, kept }`（Task 2）。

- [ ] **Step 1: 审计**：逐个阅读上述监听器，判断对已处理过的节点重复执行是否有副作用（重复 `addEventListener`、重复包裹、重复插入、累加状态）。把每个监听器的结论（幂等 / 不幂等及原因 / 修改方式）写进报告的表格。
- [ ] **Step 2: 为每个不幂等的监听器写失败测试**：同一块节点经历两次 `rendered`（第二次 `incremental:true` 且 `replaced` 不含该节点）后，断言没有重复副作用（例如监听器计数、包裹层数、插入元素数不变）。
- [ ] **Step 3: 写 `applyMarks` 清理测试**：块上有一条高亮批注 → 删除该批注（reader 数据变化）→ 增量渲染（该块源串未变、节点被保留）→ `applyMarks()` 后该块里不再有那条高亮的标记元素。
- [ ] **Step 4: 运行确认失败**（仅针对确有问题的项；全部幂等时在报告中写明"无需修改"并保留 Step 3 测试）。
- [ ] **Step 5: 实现**：优先改成幂等；只有必要时才改为只处理 `info.replaced`。
- [ ] **Step 6: 运行确认通过**，跑全量测试。
- [ ] **Step 7: Commit** `fix(reader): make rendered listeners safe for kept nodes`

### Task 4: 性能与状态验收（不提交代码）

由实施者用 Playwright MCP 在本机临时库上执行，数字写入报告；不进仓库。

前置：临时库在 `/private/tmp/claude-501/-Users-hyang-codex-tools-easyread/4d592a91-df18-4965-8fbb-d2a615fb5ec5/scratchpad/perf/lib`（论文 `e8da6cbd3328`，`job.json` 状态为 done），以 `EASYREAD_HOME=<scratchpad>/perf/home EASYREAD_LIBRARY=<scratchpad>/perf/lib EASYREAD_MODE=server <worktree>/.venv/bin/python -m easyread serve --port 18768` 启动。

- [ ] **G1**：视口 390×844，CDP `Emulation.setCPUThrottlingRate` 6；`scrollTop = 6000` 后以每帧 6px 匀速滑动 8 秒；同时在 shell 里每 2.5 秒 `touch paper.json` 共 6 次；`PerformanceObserver('longtask')` 计数 = 0。再停止滑动等待 1.5 秒，断言更新已应用（`S.versions.paper` 已变化，且 DOM 已重渲染过一次）。
- [ ] **G2**：停止滑动状态下，修改 `paper.json` 里一个已译块的 `zh` 文本（复制一份临时库，不改原文件结构）→ 从下一次 `remote` 到两帧后的耗时 ≤ 60ms；同时记录改动前的对照数（预期约 140ms，可在 base commit 上跑同一脚本）。
- [ ] **G3**：`touch paper.json`（内容不变）→ `#paper` 子树 MutationObserver 记录数 = 0。
- [ ] **G4**：对一个可见段落加 `show-en`（模拟点"原文"）→ 触发一次内容变化的更新（变化的是另一个块）→ 该段仍有 `show-en`；阅读基准块 `getBoundingClientRect().top` 前后差 ≤ 2px。
- [ ] 收尾：停止服务、删除 worktree 与父仓库里的 `.playwright-mcp/`。
