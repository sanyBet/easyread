"""服务器部署（EASYREAD_MODE=server）时挡掉只对本机有意义的接口：在服务器上移动文献库、弹 Finder、
找 Zotero 目录、关服务、自更新都不该由网页触发，统一回 403 让前端提示去桌面 App。"""
from __future__ import annotations

import re

from ..app import config
from ..app.i18n import tr

BLOCKED_POST = frozenset({
    "/api/library/move", "/api/library/inspect", "/api/library/cleanup", "/api/library/pick-folder",
    "/api/library/reveal", "/api/shutdown", "/api/migrate/scan", "/api/migrate/start", "/api/update",
})
BLOCKED_GET = frozenset({"/api/zotero/detect"})
# 论文 id 不定，单独按正则挡；在查论文之前挡住，不存在的 id 也回 403 而不是 404
_REVEAL_PAPER = re.compile(r"^/api/p/[^/]+/reveal/?$")


def blocked(method: str, path: str) -> bool:
    if not config.server_mode():
        return False
    if method == "GET":
        return path in BLOCKED_GET
    if method == "POST":
        return path in BLOCKED_POST or bool(_REVEAL_PAPER.match(path))
    return False


def body() -> dict:
    return {"error": "web_unavailable", "message": tr("Web 端不可用，请在桌面 App 中操作")}
