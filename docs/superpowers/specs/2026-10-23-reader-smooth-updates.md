---
name: reader-smooth-updates
description: "阅读页在后台翻译写入时不卡顿：滑动期间推迟重渲染、整页重渲染改为只替换变化的顶层块；涉及 rerenderKeepingPlace、remote 事件、rendered 监听器时读取"
status: active
---

# 阅读页后台更新不卡顿（spec）

## 目标

后台翻译进行中，用户在阅读页滑动不出现顿挫；更新到达后，阅读位置和已展开的状态不丢。

| 编号 | 目标 | 验收口径（Chrome，CPU 降速 6×，390×844，论文 e8da6cbd3328：150 块、47 个公式） |
|---|---|---|
| G1 | 滑动期间不因远端更新产生长任务 | 匀速滑动 8 秒，期间每 2.5 秒改一次 `paper.json`：longtask 数 = 0 |
| G2 | 停止滑动后，单次更新的开销显著下降 | 只有 1 个块文字变化时，从 `remote` 事件到两帧后 ≤ 60ms（现状约 140ms） |
| G3 | 内容不变时零 DOM 改动 | `paper.json` 只改了 mtime、内容相同：`#paper` 子树 MutationObserver 记录数 = 0 |
| G4 | 状态保留 | 已展开原文（`.show-en`）、笔记展开（`.notes-open`）、当前段（`.current`）在未变化的块上保持；阅读位置不跳（阅读基准块的 `getBoundingClientRect().top` 变化 ≤ 2px） |
| G5 | 行为不回退 | 首次加载、编辑保存、语言切换、搜索、原页面板联动、离线单文件版照旧；现有测试全过 |

## 约束

| 类别 | 约束 |
|---|---|
| 范围 | 只改阅读页前端（`easyread/web/js/reader/`）；后端轮询协议、`/versions`、`/part/*` 不变 |
| 依赖 | 不新增依赖，不引入虚拟 DOM 库 |
| 兼容 | 桌面版（Electron）、浏览器、离线导出 HTML 共用同一套代码，三者行为一致 |
| 风格 | 中文短注释只写原因；`PR.*` 命名空间；新增常量全大写；单函数 ≤ 40 行；单文件 ≤ 300 行（`render.js` 已 320 行，新代码放新文件） |

## 方案

### 1. 滑动期间推迟（`main.js` 的 `remote` 处理）

现状：`store.js` 每 2.5 秒轮询，`paper`/`reader` 变化时 `main.js` 立即调用 `PR.rerenderKeepingPlace()`。

改为：
- 新增 `PR.scrollActivity`（新文件 `reader/scroll-idle.js`）：监听 `scroll`、`wheel`、`touchstart`、`touchmove`、`touchend`（`passive: true`），记录最后活动时间与是否有手指按着。
- 导出 `PR.whenScrollIdle(fn)`：手指未按下且距最后活动 ≥ `SCROLL_IDLE_MS = 600` 时执行；否则在空闲后执行一次。多次调用合并为一次执行（保留最后一个 `fn` 不够，需要合并 `changed` 集合，见下条）。
- `remote` 处理把 `changed` 并入一个待处理集合，统一经 `whenScrollIdle` 和现有的 `busy()` 判断后执行一次 `after()`。`renderJobState()`（顶栏进度，开销小）仍立即执行。

### 2. 只替换变化的顶层块（新文件 `reader/reconcile.js`）

现状：`PR.renderPaper()` 拼出整篇 HTML 字符串后 `#paper.innerHTML = html`。

改为：
- `PR.renderPaper()` 照旧生成整篇 HTML 字符串。
- 首次渲染（`#paper` 尚无子节点）照旧用 `innerHTML`。
- 之后的渲染调用 `PR.reconcilePaper(container, html) -> { replaced: number, kept: number }`：
  1. 整篇字符串与上次完全相同 → 直接返回，不碰 DOM（G3）。
  2. 否则把新字符串解析进 `<template>`，按顶层子节点逐个比对：节点键 = `data-id`（块），没有 `data-id` 的（缺页提示、未译页区域、页上限提示等）用 "标签+class+同类序号"。
  3. 键相同且该节点**上次渲染时的源 HTML 字符串**（存在 `WeakMap<Element, string>`，不读当前 DOM，因为批注高亮等会改 DOM）与新字符串相同 → 保留旧节点。
  4. 否则用新节点替换；若旧节点有 `show-en`、`notes-open`、`current` 类，复制到新节点（与 `PR.renderBlock` 现有做法一致）。
  5. 删除新结构里不存在的旧节点，按新顺序插入新节点；尽量不移动保留节点。
- `PR.rerenderKeepingPlace()` 保持现有锚点修正逻辑。

### 3. `rendered` 监听器的幂等性

保留的旧节点会再次经过 `rendered` 事件的处理。以下监听器必须逐一确认对已处理过的节点重复执行无副作用（不重复绑定事件、不重复包裹 span、不重复插入元素）；不满足的改成幂等，或只处理新节点：

| 文件 | 监听器 |
|---|---|
| `render.js` | `fitWide()`（按元素缓存宽度，预期已幂等） |
| `pdf-text.js:85` | 原页文字层 |
| `reading-language.js:132` | `applyReadingLanguage()` |
| `note-media-drag.js:20` | `prepare` |
| `find.js:71` | 搜索高亮 |
| `pageview.js:201` | 原页联动 |
| `main.js` remote 的 `after()` | `applyMarks()`、`renderMargin()`（删除批注后需能清掉旧高亮） |

`PR.emit("rendered")` 增加参数 `{ incremental: boolean, replaced: Element[] }`，需要时监听器可只处理 `replaced`；不传参的旧调用方式仍按整页处理。

## 已知风险

| 风险 | 后果 | 缓解 |
|---|---|---|
| 推迟期间 `PR.state` 已是新数据、DOM 仍是旧内容 | 点击旧段落时取到的数据与显示不一致 | 推迟最长到滑动停止后 600ms；`buildIndex()` 仍在渲染时才执行，点击处理读取的是与 DOM 一致的旧索引 |
| 某个 `rendered` 监听器在保留节点上重复执行出错 | 重复绑定、重复包裹 | 第 3 节逐个审计并补测试 |
| 节点键冲突（无 `data-id` 的节点） | 错误保留旧节点 | 源字符串比对兜底：键相同但内容不同一律替换 |

## 验证

| 编号 | 内容 | 方法 |
|---|---|---|
| V1 | 单元测试 | `node --test tests/web/test_*.cjs tests/desktop/test_*.cjs`、`python -m unittest discover tests` 全过；新增 `tests/web/test_reader_reconcile.cjs`、`tests/web/test_reader_scroll_idle.cjs` |
| V2 | 性能（G1–G3） | Playwright 复现脚本（见计划 Task 4），在本机临时库上跑，数字记入报告 |
| V3 | 状态保留（G4） | 同一脚本：展开某段原文 → 触发更新 → 断言 `.show-en` 仍在，基准块位移 ≤ 2px |
| V4 | 线上 | 部署 t22 后，导入一篇新论文边译边读，本人在手机上滑动验收 |
