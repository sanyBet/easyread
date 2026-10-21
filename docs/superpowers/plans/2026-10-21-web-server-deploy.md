# EasyRead Web 化与 t22 部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 EasyRead 以"服务器模式"常驻 t22，经 Cloudflare Tunnel + Access 在 `https://easyread.vizce.com` 供本人多设备使用。

**Architecture:** 复用现有 stdlib HTTP 服务和原生 JS 网页；新增环境变量 `EASYREAD_MODE=server` 开关，后端据此拒绝本机文件系统类接口，前端据此隐藏或提示对应入口；文献库页补移动端布局；部署用 systemd 加现有的远程托管 tunnel，认证完全交给 Cloudflare Access。

**Tech Stack:** Python 3.10+ stdlib（`http.server`、`unittest`），原生 JS（`PR.*` 命名空间），`node --test`，systemd，Cloudflare API v4。

**Spec:** `docs/superpowers/specs/2026-10-21-web-server-deploy.md`

## Global Constraints

- 不新增 Python / npm 依赖。
- 服务器模式唯一开关：环境变量 `EASYREAD_MODE=server`，判断函数 `config.server_mode() -> bool`。
- 非服务器模式下所有现有行为不变：`python -m unittest discover tests -v` 与 `node --test tests/web/test_*.cjs tests/desktop/test_*.cjs` 全过。
- 被禁接口统一返回 `403 {"error": "web_unavailable", "message": tr("Web 端不可用，请在桌面 App 中操作")}`。
- 前端提示文案与后端相同：`Web 端不可用，请在桌面 App 中操作`；新文案同步写入 `easyread/web/i18n/en.json`、`zh-Hant.json`，并通过 `python scripts/i18n_check.py`。
- 域名 `easyread.vizce.com`；服务端口 `8765`；数据目录 `/home/ubuntu/easyread-data`；代码目录 `/home/ubuntu/apps/easyread`；运行用户 `ubuntu`。
- Access：只用 One-time PIN，会话 `720h`，放行邮箱从 `~/.secrets/cloudflare-zt.env` 的 `EASYREAD_ACCESS_EMAIL` 读取，禁止写进仓库、日志或命令行回显。
- 注释风格沿用仓库现有的中文注释。

## Review Focus

1. 带查询串或尾斜杠的被禁路径（`/api/library/reveal?x=1`、`/api/p/<id>/reveal/`）也必须被拒 → Task 2 的测试覆盖。
2. 旧的阅读页 / 文献库页缓存仍然调用被禁接口时，页面要给出可读提示，不能静默失败或报 `[object Object]` → Task 3 的测试断言 toast 文案。
3. WebSocket `Origin: https://evil.com`、Host 相同但协议拼错（`ftp://`）都要拒绝 → Task 1 的测试覆盖。
4. 820px（iPad 竖屏）同时命中 `≤1100` 和 `>760` 两档：抽屉可用，但"⋯"菜单不出现，顶栏不溢出 → Task 4 的验证覆盖。
5. 更新 tunnel 配置时不能丢掉已有的 ingress 规则（t22 上还有其他服务）→ Task 5 脚本先备份 GET 结果，并以 `--dry-run` 打印差异。

---

### Task 1: 服务器模式开关、mode 字段、WebSocket https 来源

**Files:**
- Modify: `easyread/app/config.py`（新增 `server_mode()`）
- Modify: `easyread/server/server.py:161-175`（`/api/library`、`/api/config` 加 `mode`；`/api/update` GET）、`server.py:268`（来源校验）、`server.py:293`（`/api/update` POST）
- Modify: `easyread/server/launch.py:363-385`（`open_browser`、`exit_on_close`）
- Test: `tests/server/test_server_mode.py`（新建）、`tests/server/test_presence.py`

**Interfaces:**
- Produces: `config.server_mode() -> bool`（读 `os.environ.get("EASYREAD_MODE") == "server"`，每次调用都重新读，方便测试 patch）；`/api/library` 和 `/api/config` 响应新增 `"mode": "server" | "desktop"`。

- [ ] **Step 1: 写失败测试** `tests/server/test_server_mode.py`
  - `test_server_mode_reads_env`：`patch.dict(os.environ, {"EASYREAD_MODE": "server"})` 时 `config.server_mode()` 为 True；不设置时为 False。
  - `test_library_reports_mode`：在临时 `EASYREAD_LIBRARY` 下起 `launch` 的服务（参照 `test_presence.py` 的起服务方式），GET `/api/library` 的 `mode` 在两种环境下分别为 `"server"` 和 `"desktop"`。
  - `test_update_disabled_in_server_mode`：服务器模式下 GET `/api/update` 返回 `{"disabled": true}`，且不访问网络（patch `updates.check` 后断言没有被调用）。
  - `test_serve_ignores_open_and_exit_on_close`：服务器模式下调用 `launch.serve(port, open_browser=True, exit_on_close=True)`，断言 `webbrowser.open` 没被调用，`app.presence.enabled is False`。
- [ ] **Step 2: 在 `tests/server/test_presence.py` 补用例**
  - `test_accepts_https_origin_of_same_host`：`Origin: https://127.0.0.1:{port}` → 握手返回 `101`。
  - `test_rejects_foreign_or_bad_scheme_origin`：`https://evil.com`、`ftp://127.0.0.1:{port}` → `403`。
- [ ] **Step 3: 运行，确认失败** `python -m unittest tests.server.test_server_mode tests.server.test_presence -v`，预期新用例 FAIL。
- [ ] **Step 4: 实现**：来源允许集合改为 `(None, f"http://{host}", f"https://{host}")`，两种模式通用；`serve()` 开头若 `config.server_mode()` 就把 `open_browser`、`exit_on_close` 都置为 False；GET `/api/update` 在服务器模式下直接返回 `{"disabled": True}`。
- [ ] **Step 5: 运行，确认通过**，同时跑全量 `python -m unittest discover tests -v`。
- [ ] **Step 6: Commit** `feat(server): add EASYREAD_MODE=server switch and https websocket origin`

### Task 2: 后端拒绝本机文件系统类接口

**Files:**
- Create: `easyread/server/web_mode.py`
- Modify: `easyread/server/server.py`（`_get` 与 `_post` 开头各调一次）
- Modify: `easyread/web/i18n/en.json`、`easyread/web/i18n/zh-Hant.json`
- Test: `tests/server/test_server_mode.py`

**Interfaces:**
- Consumes: `config.server_mode()`（Task 1）。
- Produces: `web_mode.blocked(method: str, path: str) -> bool`；`web_mode.BLOCKED_POST: frozenset[str]`、`web_mode.BLOCKED_GET: frozenset[str]`；`web_mode.body() -> dict`，返回统一的 403 响应体。

被禁集合（只在 `server_mode()` 为 True 时生效）：
- POST：`/api/library/move`、`/api/library/inspect`、`/api/library/cleanup`、`/api/library/pick-folder`、`/api/library/reveal`、`/api/shutdown`、`/api/migrate/scan`、`/api/migrate/start`、`/api/update`，以及匹配 `^/api/p/[^/]+/reveal/?$` 的路径。
- GET：`/api/zotero/detect`。
- `path` 一律用去掉查询串并 `unquote` 后的值，与 `_get`、`_post` 现有写法一致。

- [ ] **Step 1: 写失败测试**
  - `test_blocked_paths_return_web_unavailable`：服务器模式下，对上面每个 POST 路径（带合法 `X-Token`）、GET `/api/zotero/detect`、`/api/library/reveal?x=1`、`/api/p/abc/reveal/` 发请求，都断言 `status == 403` 且 `json["error"] == "web_unavailable"`。
  - `test_blocked_paths_untouched_in_desktop_mode`：非服务器模式下 `web_mode.blocked("POST", "/api/library/reveal")` 为 False，且 GET `/api/zotero/detect` 返回 200。
  - `test_migrate_status_still_allowed`：服务器模式下 GET `/api/migrate/status` 返回 200（前端轮询依赖它）。
- [ ] **Step 2: 运行，确认失败**。
- [ ] **Step 3: 实现** `web_mode.py`，并在 `_get`、`_post` 开头（`path` 算出之后）加 `if web_mode.blocked(...): return self._json(403, web_mode.body())`。
- [ ] **Step 4: 补 i18n**：在 `en.json` 加 `"Web 端不可用，请在桌面 App 中操作": "Not available on the web. Please use the desktop app."`，在 `zh-Hant.json` 加 `"Web 端不可用，請在桌面 App 中操作"`；运行 `python scripts/i18n_check.py`，预期通过。
- [ ] **Step 5: 运行测试，确认通过**，并跑全量单测。
- [ ] **Step 6: Commit** `feat(server): block local-filesystem endpoints in server mode`

### Task 3: 前端裁剪入口

**Files:**
- Modify: `easyread/web/js/library/app.js:104` 附近（`L.serverMode = d.mode === "server"; PR.serverMode = L.serverMode;`）
- Modify: `easyread/web/js/library/detail.js:192`（服务器模式下不加"打开所在文件夹"菜单项）
- Modify: `easyread/web/js/library/help.js:39`（服务器模式下不渲染"打开文献库文件夹"按钮）
- Modify: `easyread/web/js/library/settings-cloud.js`（服务器模式下整个区块只渲染一行：`文献库位置：{path}（Web 端不可更改）`）
- Modify: `easyread/web/js/library/import.js:79-80`（服务器模式下点 `#folderGo`、`#zoteroGo` 时调用 `PR.toast(PR.t("Web 端不可用，请在桌面 App 中操作"))`，不打开对话框）
- Modify: `easyread/web/js/common/util.js:199` 附近的 `PR.api` 错误处理：响应体 `error === "web_unavailable"` 时，抛出的 Error 的 message 用响应体里的 `message`
- Modify: i18n 两个 json（新增 `文献库位置：{path}（Web 端不可更改）`）
- Test: `tests/web/test_server_mode.cjs`（新建，用 `tests/helpers/library_page.cjs`；写法参照 `tests/web/test_cloud_settings.cjs`）

**Interfaces:**
- Consumes: `/api/library` 的 `mode`（Task 1）；403 `web_unavailable` 响应体（Task 2）。
- Produces: `PR.serverMode: boolean`，文献库页全局可读。

- [ ] **Step 1: 写失败测试** `tests/web/test_server_mode.cjs`
  - `server mode hides reveal entries`：`/api/library` 返回 `mode: "server"` 时，详情菜单里没有"打开所在文件夹"，帮助页没有 `data-help-do="library"`，设置里没有 `reveal`/`custom` 按钮，但能看到包含"Web 端不可更改"的文字。
  - `server mode folder and zotero buttons toast`：点击 `#folderGo` 和 `#zoteroGo` 后，toast 文案等于"Web 端不可用，请在桌面 App 中操作"，且不调用 `PR.openFolderImport`/`PR.openZotero`。
  - `web_unavailable error surfaces message`：模拟 `PR.api` 收到 403 `{"error":"web_unavailable","message":"Web 端不可用，请在桌面 App 中操作"}`，断言 reject 的 `error.message` 就是这句文案。
  - `desktop mode keeps entries`：`mode: "desktop"` 时上述入口全部存在。
- [ ] **Step 2: 运行，确认失败** `node --test tests/web/test_server_mode.cjs`。
- [ ] **Step 3: 按 Files 清单实现**。
- [ ] **Step 4: 运行，确认通过**，再跑 `node --test tests/web/test_*.cjs tests/desktop/test_*.cjs` 和 `python scripts/i18n_check.py`。
- [ ] **Step 5: Commit** `feat(web): hide or explain desktop-only entries in server mode`

### Task 4: 文献库页移动端适配，阅读页"长按"文案

**Files:**
- Modify: `easyread/web/library.html:23-36`（顶栏最左侧加 `<button class="btn icon side-btn" id="sideBtn">`；在 `#settingsBtn` 之前加 `<button class="btn icon more-btn" id="moreBtn">`）
- Modify: `easyread/web/css/library.css:112-125`（≤1100：`.side-btn` 显示，`.lib.side-open .side` 改成 `position: fixed; left: 0; top: var(--bar-h); bottom: 0; width: min(300px, 86vw); display: block; z-index: 30; box-shadow: var(--shadow-lg)`，并加遮罩 `.side-mask`；≤760：隐藏 `.lang-btn`、`.help-btn`、`.theme-btn`，显示 `.more-btn`；任何宽度 `.topbar` 都用 `flex-wrap: nowrap`，`.search` 用 `min-width: 0`）
- Modify: `easyread/web/js/library/sidebar.js`（`#sideBtn` 切换 `.lib.side-open`；点击遮罩、选中分类、按 Esc 时收起）
- Modify: `easyread/web/js/library/app.js`（`#moreBtn` 打开菜单，菜单项为主题、语言、帮助，分别调用这三个按钮现有的点击处理；菜单组件复用 `detail.js` 现在用的那个）
- Modify: 阅读页首次提示所在的 JS（实施时用 `grep -rn "右键" easyread/web/js/reader` 定位）：`matchMedia("(pointer: coarse)").matches` 时用"长按"版本的文案；新文案补进 i18n
- Test: `tests/web/test_library_navigation.cjs`（补抽屉开合用例）

**Interfaces:**
- Consumes: 无。
- Produces: CSS 类 `.lib.side-open`、`.side-mask`，元素 `#sideBtn`、`#moreBtn`。

- [ ] **Step 1: 写失败测试**（`test_library_navigation.cjs`）：`side drawer toggles and closes on category pick`，点 `#sideBtn` 后 `.lib` 有 `side-open`；选中一个分类后去掉 `side-open`。
- [ ] **Step 2: 运行，确认失败**；**Step 3: 实现**；**Step 4: 运行通过**，并跑全量 node 测试。
- [ ] **Step 5: 视觉验证**：用临时库起服务（`EASYREAD_HOME`、`EASYREAD_LIBRARY` 指向 scratchpad，导入任意一篇 PDF 并加 `--no-translate`），用 Playwright 分别在 390×844、820×1180、1440×900 下打开 `/`。每个尺寸都断言 `document.documentElement.scrollWidth <= innerWidth`，`#importBtn`、`#settingsBtn` 的 `getBoundingClientRect().right <= innerWidth`。390 下点 `#moreBtn` 能看到三个菜单项；390 和 820 下点 `#sideBtn` 能看到分类和回收站；1440 下布局和改动前一致。截图存到 scratchpad，不进仓库。
- [ ] **Step 6: Commit** `feat(web): responsive library topbar and sidebar drawer`

### Task 5: 部署文件与部署文档

**Files:**
- Create: `deploy/easyread.service`
- Create: `deploy/t22_update.sh`
- Create: `deploy/backup.sh`
- Create: `deploy/cloudflare_access.sh`
- Create: `docs/server-deploy.md`（结构：目标 → 约束 → 方案 → 验证；按仓库现有 `docs/*.md` 平铺的习惯放置）
- Modify: `README.md`（在合适位置加一行链接到 `docs/server-deploy.md`）

**Interfaces:**
- Consumes: `EASYREAD_MODE=server`（Task 1）。
- Produces: systemd 单元 `easyread.service`；脚本参数约定见下。

内容要点：
- `easyread.service`：`User=ubuntu`、`WorkingDirectory=/home/ubuntu/apps/easyread`、`Environment=EASYREAD_MODE=server`、`Environment=EASYREAD_HOME=/home/ubuntu/easyread-data`、`Environment=PATH=/home/ubuntu/.local/node/bin:/usr/local/bin:/usr/bin:/bin`、`Environment=PYTHONIOENCODING=utf-8`、`ExecStart=/home/ubuntu/apps/easyread/.venv/bin/python -m easyread serve --port 8765`、`Restart=always`、`RestartSec=3`、`MemoryMax=1200M`、`UMask=0077`。
- `t22_update.sh`：`set -euo pipefail`；依次 `git pull --ff-only`、`.venv/bin/pip install -q -e .`、`sudo systemctl restart easyread`；最后循环 15 秒等 `curl -sf http://127.0.0.1:8765/api/version` 成功，失败则 exit 1。
- `backup.sh`：`tar czf ~/easyread-backups/easyread-$(date +%F).tgz -C ~ easyread-data`，然后用 `ls -1t … | tail -n +8 | xargs -r rm` 只保留 7 份；crontab 行 `30 4 * * * /home/ubuntu/apps/easyread/deploy/backup.sh` 写在文档里。
- `cloudflare_access.sh`：`set -euo pipefail`；`source ~/.secrets/cloudflare-zt.env`；不 `set -x`，也不回显 token 或邮箱。支持 `--dry-run`（只打印将做的变更，邮箱打码成 `a***@domain`）。
  1. GET tunnel 配置，先存到 `$(mktemp)`，然后用 `python3 -c` 处理 JSON：如果 `easyread.vizce.com` 的规则不存在，就插到最后一条兜底 `http_status:404` 规则之前，再 PUT；已存在就跳过。
  2. DNS：查不到 `easyread.vizce.com` 时创建 CNAME `<CF_TUNNEL_ID>.cfargotunnel.com`，`proxied: true`。
  3. 查身份提供方，没有 `onetimepin` 就创建；查 Access 应用，没有 `easyread.vizce.com` 就创建（`type=self_hosted`、`session_duration=720h`、`allowed_idps=[OTP 的 id]`、`auto_redirect_to_identity=true`），并创建 Allow 策略 `include: [{email: {email: $EASYREAD_ACCESS_EMAIL}}]`。
  4. 列出 Access 应用：除 EasyRead 外还有其他应用时，打印"跳过登录页品牌设置"并结束；否则 PUT organization 的 `login_design`（`background_color: "#f6f3ec"`、`text_color: "#23211d"`、`logo_path` 用 `https://raw.githubusercontent.com/sanyBet/easyread/main/electron/assets/icon.png`、`header_text: "EasyRead"`）。
  5. 每一步的结果打印成一行：`created` / `exists` / `skipped`。

- [ ] **Step 1: 写文件**。
- [ ] **Step 2: 静态检查**：`bash -n deploy/*.sh` 无输出；如果本机有 `shellcheck`，再跑 `shellcheck deploy/*.sh`；`systemd-analyze verify` 在 t22 上做（Task 6）。
- [ ] **Step 3: Commit** `chore(deploy): add t22 systemd unit, scripts and deploy guide`

### Task 6: 部署到 t22 并配置 Cloudflare

前置条件（需要用户提供）：`~/.secrets/cloudflare-zt.env`（0600），包含 `CF_API_TOKEN`、`CF_ACCOUNT_ID`、`CF_TUNNEL_ID`、`EASYREAD_ACCESS_EMAIL`。token 权限：Account → Cloudflare Tunnel Edit、Access: Apps and Policies Edit、Access: Organizations, Identity Providers, and Groups Edit；Zone vizce.com → DNS Edit。

**Files:** 无代码改动（Task 1–5 已合并到 fork 的 `main` 并 push）。

- [ ] **Step 1**：`ssh t22`，执行 `git clone https://github.com/sanyBet/easyread.git ~/apps/easyread`、`python3 -m venv .venv`、`.venv/bin/pip install -e .`、`mkdir -m 700 ~/easyread-data ~/easyread-backups`。
- [ ] **Step 2**：`sudo cp deploy/easyread.service /etc/systemd/system/`，然后 `sudo systemd-analyze verify easyread.service`（预期无报错），再 `sudo systemctl enable --now easyread`。
- [ ] **Step 3**：t22 上执行 `curl -sf http://127.0.0.1:8765/api/library | python3 -c "import json,sys;print(json.load(sys.stdin)['mode'])"`，预期输出 `server`。
- [ ] **Step 4**：在本机执行 `deploy/cloudflare_access.sh --dry-run`，人工确认差异只涉及 easyread，然后不带参数正式执行，预期每一步输出 `created` 或 `exists`。
- [ ] **Step 5**：安装 crontab 备份行，手动执行一次 `deploy/backup.sh`，确认生成了 `~/easyread-backups/easyread-<今天>.tgz`。

### Task 7: 小额实测与链路验证

只会产生一次翻译 1 页、问 AI 1 次的 API 费用（量级在几分钱以内）。

- [ ] **V5**：`curl -sI https://easyread.vizce.com/api/library`，预期 `302` 跳到 `*.cloudflareaccess.com`；浏览器用放行邮箱收验证码登录成功；用另一个邮箱请求验证码，拿不到或被拒。
- [ ] **V6**：在设置页填 API Key，并发翻译数设为 1；手机上导入 arXiv `1706.03762`，只翻译第 1 页；问 AI 一个问题，确认回答逐段出现，没有等全部生成完才一次性出现；在电脑上给同一段写一条笔记，手机端 5 秒内看到。
- [ ] **V4（线上）**：手机上依次打开设置、帮助、分类抽屉；点"导入整个文件夹"，看到提示"Web 端不可用，请在桌面 App 中操作"。
- [ ] **V7**：t22 上 `sudo kill -9 $(systemctl show -p MainPID --value easyread)`，10 秒内 `systemctl is-active easyread` 输出 `active`。
- [ ] **收尾**：在 `docs/server-deploy.md` 的"验证"一节记录本次结果（日期、各项是否通过）并 commit；再在 t22 上执行一次 `deploy/t22_update.sh`，确认升级流程可用。
