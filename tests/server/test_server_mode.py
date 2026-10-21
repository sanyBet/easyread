"""EASYREAD_MODE=server：接口报 mode、不查更新、不开浏览器也不随页面关闭退出。  python -m unittest tests.server.test_server_mode"""
import json
import os
import tempfile
import threading
import time
import unittest
import urllib.request
from unittest.mock import patch

from easyread.app import config
from easyread.server import launch, server

# 浏览器是 0.4 秒后才开的，多等一点再断言没开
BROWSER_TIMER_WAIT = 0.6


class ServerModeConfigTest(unittest.TestCase):
    def test_server_mode_reads_env(self):
        with patch.dict(os.environ, {"EASYREAD_MODE": "server"}):
            self.assertTrue(config.server_mode())
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("EASYREAD_MODE", None)
            self.assertFalse(config.server_mode())
        with patch.dict(os.environ, {"EASYREAD_MODE": "desktop"}):
            self.assertFalse(config.server_mode())


class ServerModeHttpTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"EASYREAD_LIBRARY": tempfile.mkdtemp()})
        self.env.start()
        self.app = server.App(server.config.load())
        server.Handler.app = self.app
        self.httpd = launch._Server(("127.0.0.1", 0), server.Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.env.stop()

    def get(self, path: str) -> dict:
        return json.loads(urllib.request.urlopen(self.url + path, timeout=10).read())

    def test_library_reports_mode(self):
        with patch.dict(os.environ, {"EASYREAD_MODE": "server"}):
            self.assertEqual(self.get("/api/library")["mode"], "server")
            self.assertEqual(self.get("/api/config")["mode"], "server")
        os.environ.pop("EASYREAD_MODE", None)
        self.assertEqual(self.get("/api/library")["mode"], "desktop")
        self.assertEqual(self.get("/api/config")["mode"], "desktop")

    def test_update_disabled_in_server_mode(self):
        with patch.dict(os.environ, {"EASYREAD_MODE": "server"}), patch.object(server.updates, "check") as check:
            self.assertEqual(self.get("/api/update"), {"disabled": True})
            self.assertEqual(self.get("/api/update?force=1"), {"disabled": True})
        check.assert_not_called()

    def test_update_still_checks_in_desktop_mode(self):
        os.environ.pop("EASYREAD_MODE", None)
        with patch.object(server.updates, "check", return_value={"latest": "x"}) as check:
            self.assertEqual(self.get("/api/update"), {"latest": "x"})
        check.assert_called_once()


class _OneShotServer(launch._Server):
    def serve_forever(self, poll_interval=0.5):
        return None  # serve() 里起完就返回，测试不用另开线程去停


class ServeInServerModeTest(unittest.TestCase):
    def test_serve_ignores_open_and_exit_on_close(self):
        env = {"EASYREAD_MODE": "server", "EASYREAD_LIBRARY": tempfile.mkdtemp()}
        with patch.dict(os.environ, env), patch.object(launch, "_Server", _OneShotServer), \
                patch.object(launch, "setup_log"), patch.object(launch.detect, "warm"), \
                patch.object(launch.webbrowser, "open") as browser_open:
            launch.serve(0, open_browser=True, exit_on_close=True)
            time.sleep(BROWSER_TIMER_WAIT)
        browser_open.assert_not_called()
        self.assertIs(server.Handler.app.presence.enabled, False)


if __name__ == "__main__":
    unittest.main()
