---
name: server-deploy
description: "EasyRead 在 t22 上以服务器模式（EASYREAD_MODE=server）运行，经 Cloudflare Tunnel + Access 只对本人开放 easyread.vizce.com；涉及首次部署、升级、备份恢复、回滚、Access 配置或 web 端禁用功能时读取"
status: active
---

# t22 服务器部署

## 目标

在 t22 上常驻运行 EasyRead，本人通过 `https://easyread.vizce.com` 在桌面、手机、平板上使用；公网只有通过 Cloudflare Access 认证的放行邮箱能进入。

| 编号 | 目标 | 验收口径 |
|---|---|---|
| G1 | 只有本人能访问 | 未登录访问任一路径跳 Access 登录页；非放行邮箱拿不到验证码 |
| G2 | 崩溃自动拉起 | systemd 托管，`kill -9` 后 10 秒内恢复 active |
| G3 | web 端不提供本机文件系统类功能 | 见下文"web 端禁用功能"；对应接口返回 403 `web_unavailable` |

设计与取舍见 [spec](superpowers/specs/2026-10-21-web-server-deploy.md)。

## 约束

部署只用现有组件，凭证不进仓库。

| 类别 | 约束 |
|---|---|
| 主机 | t22：Ubuntu 24.04，用户 `ubuntu`，Python 3.12（`/usr/bin/python3`），node v22 在 `~/.local/node/bin`（不在默认 PATH，由 unit 文件补上） |
| 入口 | cloudflared 是远程托管 tunnel（token 模式），ingress 通过 API 修改，不改本地配置文件 |
| 监听 | 服务只监听 `127.0.0.1:8765`，只由 cloudflared 连入 |
| 凭证 | `~/.secrets/cloudflare-zt.env`（0600），只被 `deploy/cloudflare_access.sh` `source`；脚本不回显 token，邮箱打码为 `a***@domain` |
| 数据 | `EASYREAD_HOME=~/easyread-data`（0700），`config.json` 0600；服务 `UMask=0077` |
| 内存 | `MemoryMax=1200M`；翻译并发数设为 1 |

### Cloudflare token 权限

`CF_API_TOKEN` 需要以下权限，缺一项脚本会在对应步骤报 HTTP 403 并停止。

| 范围 | 权限 |
|---|---|
| Account | Cloudflare Tunnel：Edit |
| Account | Access: Apps and Policies：Edit |
| Account | Access: Organizations, Identity Providers, and Groups：Edit |
| Zone `vizce.com` | DNS：Edit（脚本用 `GET /zones?name=vizce.com` 查 zone id；若这一步报 403 或查不到，再加 Zone：Read） |

`~/.secrets/cloudflare-zt.env` 格式（每行 `export NAME=value`）：

```bash
export CF_API_TOKEN=...
export CF_ACCOUNT_ID=...
export CF_TUNNEL_ID=...
export EASYREAD_ACCESS_EMAIL=...
```

### web 端禁用功能

服务器模式下以下功能在前端隐藏或点击后提示"Web 端不可用，请在桌面 App 中操作"，后端同时返回 403。

| 功能 | 前端处理 | 后端接口 |
|---|---|---|
| 打开所在文件夹（单篇） | 隐藏 | `/api/p/<id>/reveal` |
| 打开文献库文件夹 | 隐藏 | `/api/library/reveal` |
| 文献库位置迁移、网盘库 | 改为只读文字 | `/api/library/move`、`/inspect`、`/cleanup`、`/pick-folder` |
| 导入整个文件夹 | 保留按钮，点击提示 | `/api/migrate/scan`、`/api/migrate/start` |
| 从 Zotero 迁移 | 保留按钮，点击提示 | `/api/zotero/detect`、`/api/migrate/scan`、`/api/migrate/start` |
| 链接本地 PDF（不复制） | 随上两项不可用 | 同上 |
| 远程关闭服务 | 无入口 | `/api/shutdown` |
| 检查新版本 | 不检查 | GET `/api/update` 返回 `{"disabled": true}`，POST 返回 403 |

### 已知风险（已接受）

| 风险 | 后果 | 缓解 |
|---|---|---|
| t22 本机进程可直连 `127.0.0.1:8765`，绕过 Access | 被攻破的本机服务可读写文献库、读 API Key | 不防；`config.json` 保持 0600 |
| 多设备时钟偏差 | 后写的修改可能被先写的覆盖 | 各设备开启自动校时 |
| 两台设备同时编辑整篇笔记 | 一方内容被覆盖 | 单用户场景少见，不处理 |
| 备份与数据在同一块盘 | 盘坏则备份也丢 | 第一版接受；以后可 rsync 到本机 |
| 登录页品牌是账号级设置 | 影响同账号其他 Access 应用 | 脚本发现其他 Access 应用时跳过品牌设置 |

## 方案

部署文件都在仓库 `deploy/` 下，首次安装按顺序执行一次，之后只用升级、备份和回滚流程。

| 文件 | 作用 |
|---|---|
| `deploy/easyread.service` | systemd unit：`EASYREAD_MODE=server`、端口 8765、`Restart=always`、`MemoryMax=1200M` |
| `deploy/t22_update.sh` | 升级：`git pull --ff-only` → `pip install -e .` → 重启 → 15 秒内等 `/api/version` 成功，否则 exit 1 |
| `deploy/backup.sh` | 备份 `~/easyread-data` 到 `~/easyread-backups/easyread-YYYY-MM-DD.tgz`，保留最新 7 份 |
| `deploy/cloudflare_access.sh` | 幂等配置 tunnel ingress、DNS、One-time PIN、Access 应用与策略、登录页品牌；支持 `--dry-run` |

### 首次安装

1. 在 t22 上拉代码并建虚拟环境（产出 `~/apps/easyread/.venv`）：

   ```bash
   mkdir -p ~/apps && cd ~/apps
   git clone https://github.com/sanyBet/easyread.git
   cd easyread
   python3 -m venv .venv
   .venv/bin/pip install -e .
   ```

2. 建数据和备份目录（依赖无；产出 0700 目录）：

   ```bash
   install -d -m 700 ~/easyread-data ~/easyread-backups
   ```

3. 安装并启动服务（依赖 1、2）：

   ```bash
   sudo cp ~/apps/easyread/deploy/easyread.service /etc/systemd/system/
   sudo systemd-analyze verify /etc/systemd/system/easyread.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now easyread
   curl -sf http://127.0.0.1:8765/api/version
   ```

4. 配置 Cloudflare（依赖 3；在存放 `~/.secrets/cloudflare-zt.env` 的机器上运行，只需 bash、curl、python3）：先 dry-run 看计划，确认后正式执行。

   ```bash
   deploy/cloudflare_access.sh --dry-run
   deploy/cloudflare_access.sh
   ```

   每一步输出一行结果：

   | 步骤 | 内容 | 结果取值 |
   |---|---|---|
   | `tunnel-ingress` | 在兜底 `http_status:404` 规则前插入 `easyread.vizce.com → http://127.0.0.1:8765`，其他规则不动 | `created` / `exists` |
   | `dns` | `easyread` CNAME → `<CF_TUNNEL_ID>.cfargotunnel.com`，proxied | `created` / `exists` |
   | `otp-idp` | 身份提供方 One-time PIN | `created` / `exists` |
   | `access-app` | self-hosted，会话 `720h`，只用 One-time PIN，自动跳转 | `created` / `exists` |
   | `access-policy` | Allow，include 放行邮箱 | `created` / `exists` |
   | `login-branding` | 登录页背景 `#f6f3ec`、文字 `#23211d`、Logo、标题 `EasyRead` | `created` / `exists` / `skipped`（有其他 Access 应用时） |

   脚本出错时打印 `HTTP 状态码: Cloudflare 错误码: 信息` 后停止；修好权限后重跑即可，已完成的步骤显示 `exists`。

5. 加每日备份（依赖 2）：`crontab -e` 加一行：

   ```cron
   30 4 * * * /home/ubuntu/apps/easyread/deploy/backup.sh
   ```

6. 浏览器打开 `https://easyread.vizce.com`，用放行邮箱登录；在"设置 → 模型"配置 OpenAI 兼容 API Key，"同时翻译几篇"设为 1。

### 升级

在 t22 上执行，脚本失败（exit 1）时按提示看 `journalctl -u easyread -n 50`：

```bash
~/apps/easyread/deploy/t22_update.sh
```

`t22_update.sh` 用 `sudo systemctl restart`，要求 `ubuntu` 用户有免密 sudo。

### 备份与恢复

备份每天 04:30 自动执行，也可手动运行 `deploy/backup.sh`。恢复步骤：

```bash
sudo systemctl stop easyread
mv ~/easyread-data ~/easyread-data.before-restore-$(date +%F-%H%M)
tar xzf ~/easyread-backups/easyread-YYYY-MM-DD.tgz -C ~
chmod 700 ~/easyread-data
sudo systemctl start easyread
curl -sf http://127.0.0.1:8765/api/version
```

确认数据正常后再删除 `~/easyread-data.before-restore-*`。备份时服务不停，个别文件在打包期间被改动时 tar 会给出警告，归档照常保留。

### 回滚

新版本有问题时切回上一个提交并重启：

```bash
cd ~/apps/easyread
git log --oneline -5
git checkout <上一个正常的提交>
.venv/bin/pip install -q -e .
sudo systemctl restart easyread
curl -sf http://127.0.0.1:8765/api/version
```

回滚后处于 detached HEAD，`t22_update.sh` 的 `git pull --ff-only` 会失败；修复发布后先 `git checkout main`，再运行 `deploy/t22_update.sh`。

## 验证

部署完成后逐项执行并填写结果。

| 编号 | 验证内容 | 方法 | 结果 |
|---|---|---|---|
| V0 | unit 文件语法 | `sudo systemd-analyze verify /etc/systemd/system/easyread.service` 无输出 | |
| V5 | 公网认证 | 无 cookie 时 `curl -I https://easyread.vizce.com/api/library` 返回 302 到 `*.cloudflareaccess.com`；浏览器用放行邮箱登录成功，其他邮箱收不到验证码 | |
| V6 | 线上链路 | 手机加电脑：导入一篇 arXiv 论文，翻译 1 页，问 AI 一次（流式逐段出现），写一条笔记，另一台设备 5 秒内看到 | |
| V7 | 自愈 | `sudo kill -9 $(systemctl show -p MainPID --value easyread)`，10 秒内 `systemctl is-active easyread` 为 active | |
| V8 | web 端禁用接口 | 登录后访问 `/api/library/reveal` 等接口返回 403 `web_unavailable` | |
| V9 | 备份 | 手动运行 `deploy/backup.sh`，`~/easyread-backups` 下出现当天 tgz，`tar tzf` 可列出 `easyread-data/` | |
| V10 | 幂等 | 再次运行 `deploy/cloudflare_access.sh --dry-run`，所有步骤为 `exists` 或 `skipped` | |
