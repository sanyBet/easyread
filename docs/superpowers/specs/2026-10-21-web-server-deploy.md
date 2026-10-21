---
name: web-server-deploy
description: "EasyRead web 化：服务器模式、web 版功能裁剪、文献库页移动端适配、t22 + Cloudflare Access 部署；涉及服务器部署、EASYREAD_MODE、web 端禁用功能、Access 配置时读取"
status: draft
---

# EasyRead web 化与 t22 部署（spec）

## 目标

本人通过浏览器在不同设备（桌面、手机、平板）访问 `https://easyread.vizce.com`，使用除"本机文件系统类"功能外的完整功能。

| 编号 | 目标 | 验收口径 |
|---|---|---|
| G1 | 公网只有通过 Cloudflare Access 认证的本人能访问 | 未登录访问任一路径 → 跳 Access 登录页；非放行邮箱拿不到验证码或被拒 |
| G2 | 服务在 t22 常驻，崩溃自动拉起 | `systemctl` 托管，`kill -9` 后 10 秒内恢复 |
| G3 | web 版隐藏或提示不适合 web 的功能 | 见"方案 2"清单；对应后端接口在服务器模式下返回 403 |
| G4 | 文献库页在 390px / 820px 宽度下所有入口可达 | 导入、设置、帮助、主题、语言、分类、回收站都能点到；无横向溢出 |
| G5 | 桌面版（Electron、start.sh）行为不变 | 现有测试全过；非服务器模式下所有入口照旧 |

## 约束

| 类别 | 约束 |
|---|---|
| 范围 | 单用户；不做多用户、不做应用内登录；本机文献库不迁移，服务器空库起步 |
| 安全 | 访问控制完全交给 Cloudflare Access；不防 t22 本机进程绕过（已决定，见"已知风险"） |
| 依赖 | 不新增 Python / npm 依赖 |
| 主机 | t22：Ubuntu 24.04、4 核、3.6G 内存（可用约 2.2G）、磁盘余 41G；已有远程托管的 cloudflared tunnel、Caddy、Python 3.12、`~/.local/node`（v22） |
| 运行身份 | `ubuntu` 用户 |
| 凭证 | 新 Cloudflare token 与放行邮箱存 `~/.secrets/cloudflare-zt.env`（0600），只被脚本 `source`，不进仓库、不进日志 |
| 代码风格 | 遵循仓库现有风格（中文注释、`PR.*` 前端命名空间、stdlib HTTP server） |

## 方案

### 1. 服务器模式

由环境变量 `EASYREAD_MODE=server` 开启，集中在 `config.server_mode()` 判断。

| 行为 | 桌面/本地 | 服务器模式 |
|---|---|---|
| 监听 | `127.0.0.1:port` | 不变（只由 cloudflared 连入） |
| 打开浏览器 | `--open` 时打开 | 忽略 |
| `.server.json` | 写，供 CLI 复用 | 照写（服务器上的 CLI 仍可复用） |
| 关页即退出 | `--exit-on-close` 时启用 | 强制关闭 |
| 检查新版本 `/api/update` | 每天一次 | GET 返回 `{"disabled": true}`，POST 返回 403 |
| WebSocket 来源校验 | 只认 `http://{Host}` | 额外接受 `https://{Host}`（`server.py:268`） |
| `/api/config` | 原样 | 增加 `"mode": "server"`；前端写入 `PR.serverMode` |

`https://{Host}` 在桌面模式下也接受不会带来风险（来源仍必须等于自身 Host），所以 WebSocket 来源校验改为两种模式通用，不加分支。

### 2. web 版功能裁剪

原则：入口能隐藏就隐藏；入口所在的位置本身是用户找这个功能的地方（导入对话框），就保留按钮、点击后提示"Web 端不可用，请在桌面 App 中操作"。后端同时拒绝，防止旧页面缓存或手动请求。

| 功能 | 前端入口 | 前端处理 | 后端接口（服务器模式 403） |
|---|---|---|---|
| 打开所在文件夹（单篇） | `detail.js:192` 菜单项 | 隐藏 | `/api/p/<id>/reveal` |
| 打开文献库文件夹 | `help.js:39`、`settings-cloud.js:74,93` | 隐藏 | `/api/library/reveal` |
| 文献库位置迁移、网盘库 | `settings-cloud.js` 整个"文献库位置"区块 | 换成一行只读文字："文献库位置：<路径>（Web 端不可更改）" | `/api/library/move`、`/inspect`、`/cleanup`、`/pick-folder` |
| 导入整个文件夹 | `import.js:33` `#folderGo` | 保留按钮，点击弹提示 | `/api/migrate/scan`、`/api/migrate/start`（`source=folder`） |
| 从 Zotero 迁移 | `import.js:34` `#zoteroGo` | 保留按钮，点击弹提示 | `/api/zotero/detect`、`/api/migrate/scan`、`/api/migrate/start` |
| 链接本地 PDF（不复制） | 属于文件夹/Zotero 导入流程 | 随上两项一起不可用 | 同上 |
| 远程关闭服务 | `/api/shutdown` | 无前端入口 | `/api/shutdown` |
| 桌面更新、重启 | `easyreadDesktop` 桥接 | 已按桥接对象是否存在判断，不改 | — |

后端实现：在 `server.py` 里维护一个 `SERVER_BLOCKED` 路径集合（另加一个 `/api/p/*/reveal` 的规则），`do_GET`/`do_POST` 分发前先检查，命中则返回 `403 {"error": "web_unavailable", "message": <i18n 文案>}`。提示文案走 `tr()`，同时补 `en.json` 和 `zh-Hant.json`，并通过 `scripts/i18n_check.py`。

### 3. 文献库页移动端适配

只改 `library.html`、`library.css`，以及 `sidebar.js` 或 `app.js` 里少量的交互代码。

| 宽度 | 改动 |
|---|---|
| ≤ 1100px | 顶栏左侧加汉堡按钮 `#sideBtn`，点击把 `.side` 以左侧抽屉（`position: fixed`，带遮罩）展开；点遮罩或选中分类后收起 |
| ≤ 760px | 顶栏的语言、帮助、主题按钮收进"⋯"菜单 `#moreBtn`（复用现有菜单组件）；导入按钮只留图标；设置按钮常驻 |
| 全部 | 顶栏 `flex-wrap: nowrap` + 搜索框 `min-width: 0`，保证 390px 下没有横向溢出 |

阅读页只改一处文案：触屏设备上提示里的"右键"改成"长按"（检测 `matchMedia("(pointer: coarse)")`）。

### 4. Cloudflare 配置（脚本化）

脚本 `deploy/cloudflare_access.sh`，幂等，读取 `~/.secrets/cloudflare-zt.env`（`CF_API_TOKEN`、`CF_ACCOUNT_ID`、`CF_TUNNEL_ID`、`EASYREAD_ACCESS_EMAIL`）。

| 步骤 | API | 内容 |
|---|---|---|
| 1 | Tunnel configurations（GET 后合并再 PUT） | 在现有 ingress 的兜底规则前插入 `easyread.vizce.com → http://127.0.0.1:8765`，原有规则保持不变 |
| 2 | DNS | `easyread` CNAME → `<tunnel-id>.cfargotunnel.com`，proxied |
| 3 | Access app（self-hosted） | 域名 `easyread.vizce.com`，会话 30 天（`720h`），身份提供方只用 One-time PIN |
| 4 | Access policy | Allow，include `email = $EASYREAD_ACCESS_EMAIL` |
| 5 | Login page 品牌 | 组织名 `EasyRead`、背景 `#f6f3ec`、Logo（仓库内 `easyread/web/favicon.svg` 对应的 PNG，用 GitHub raw URL 或现有可公开地址） |

执行顺序（实现偏离上表编号）：One-time PIN → 3 → 4 → 5 → 2 → 1。DNS 和 ingress 一旦生效域名就对公网可达，必须等 Access 应用和策略都确认存在后才执行，任何时刻都不能出现未鉴权窗口；前面任一步失败，脚本停止，不碰 DNS 和 ingress。

风险：登录页品牌是账号级设置，会影响同一 Cloudflare 账号下的其他 Access 应用。脚本先列出现有 Access 应用；如果有其他应用，跳过步骤 5，交给用户决定。

token 需要的权限：Account → Cloudflare Tunnel Edit、Access: Apps and Policies Edit、Access: Organizations, Identity Providers, and Groups Edit；Zone vizce.com → DNS Edit。

### 5. t22 部署

| 项目 | 取值 |
|---|---|
| 代码 | `~/apps/easyread`，`git clone https://github.com/sanyBet/easyread.git`，跟踪 `main` |
| 虚拟环境 | `~/apps/easyread/.venv`（`python3 -m venv`，`pip install -e .`） |
| 数据 | `EASYREAD_HOME=~/easyread-data`（0700），其中 `config.json` 为 0600 |
| 进程 | systemd unit `easyread.service`：`User=ubuntu`、`Environment=EASYREAD_MODE=server EASYREAD_HOME=…`、`Environment=PATH=/home/ubuntu/.local/node/bin:…`（供 `checks.py` 找到 node）、`ExecStart=.venv/bin/python -m easyread serve --port 8765`、`Restart=always`、`MemoryMax=1200M` |
| 端口 | 8765（t22 上未占用，已核对 `ss -ltn`） |
| 翻译引擎 | 部署后在设置页配置 OpenAI 兼容 API Key；并发翻译数设为 1 |
| 备份 | cron 每天 04:30 执行 `tar czf ~/easyread-backups/easyread-$(date +%F).tgz -C ~ easyread-data`，保留 7 份 |
| 升级 | `deploy/t22_update.sh`：`git pull --ff-only && pip install -e . && systemctl restart easyread` |

部署文件放在仓库 `deploy/` 下：`easyread.service`、`t22_update.sh`、`cloudflare_access.sh`、`backup.sh`。

## 已知风险（已接受）

| 风险 | 后果 | 接受理由 / 缓解 |
|---|---|---|
| t22 本机进程可以直连 `127.0.0.1:8765`，绕过 Access | 被攻破的本机服务可以读写文献库、读 API Key | 用户已决定不防；`config.json` 仍保持 0600 |
| 多设备的时钟偏差导致后写的修改被先写的覆盖 | 少量修改丢失 | 各设备开启自动校时 |
| 两台设备同时编辑整篇论文笔记 | 一方的内容被覆盖 | 单用户场景下很少发生，不处理 |
| 备份和数据在同一块盘 | 盘坏则备份也丢 | 第一版接受；以后可以加 rsync 到本机 |

## 验证

| 编号 | 验证内容 | 方法 |
|---|---|---|
| V1 | 桌面模式不受影响 | `python -m unittest discover tests -v` 全过；`scripts/i18n_check.py` 通过 |
| V2 | 服务器模式下被裁剪的接口 | 新增单测：每个被禁路径返回 403 `web_unavailable`；非服务器模式下同一路径照旧可用 |
| V3 | WebSocket 接受 https 来源 | 在 `test_presence.py` 增加 `Origin: https://{Host}` 握手成功、`https://evil.com` 被拒的用例 |
| V4 | 移动端 | Playwright 在 390×844、820×1180 下打开文献库页：`scrollWidth ≤ innerWidth`，导入、设置、分类抽屉、"⋯"菜单都可点击；截图存档 |
| V5 | 公网认证 | 无 cookie 时 `curl -I https://easyread.vizce.com/api/library` 返回 302 到 `*.cloudflareaccess.com`；浏览器用放行邮箱登录成功 |
| V6 | 线上链路 | 真机（手机加电脑）：导入一篇 arXiv 论文，翻译 1 页，问 AI 一次（确认流式输出逐段出现），写一条笔记，在另一台设备 5 秒内看到 |
| V7 | 自愈 | `kill -9` 主进程，10 秒内 `systemctl is-active` 恢复为 active |
