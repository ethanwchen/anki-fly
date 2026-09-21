"""Anki Fly: a connectome-driven fruit fly that studies with you.

The simulation and rendering live in web/ (JavaScript, inside an AnkiWebView). This module
only positions the widget and forwards review events.
"""
from __future__ import annotations

import json
import os

from aqt import gui_hooks, mw
from aqt.qt import QAction, QColor, QEvent, QObject, Qt, QUrl
from aqt.webview import AnkiWebView

PKG = mw.addonManager.addonFromModule(__name__)
ADDON_DIR = os.path.dirname(os.path.abspath(__file__))
USER_FILES = os.path.join(ADDON_DIR, "user_files")
MEMORY_PATH = os.path.join(USER_FILES, "memory.json")

mw.addonManager.setWebExports(__name__, r"web/.*")


def get_config() -> dict:
    return mw.addonManager.getConfig(__name__) or {}


class FlyWidget(QObject):
    def __init__(self) -> None:
        super().__init__(mw)
        self.cfg = get_config()
        host = mw.form.centralwidget
        self.web = AnkiWebView(parent=host, title="anki_fly")
        self.web.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.web.disable_zoom()
        self.web.set_bridge_command(self.on_cmd, self)
        self._apply_transparency()
        # AnkiWebPage refuses main-frame navigation to /_addons/ URLs unless this is off.
        self.web.set_open_links_externally(False)
        self.web.load_url(QUrl(f"{mw.serverURL()}_addons/{PKG}/web/index.html"))
        host.installEventFilter(self)
        mw.bottomWeb.installEventFilter(self)
        mw.toolbarWeb.installEventFilter(self)
        gui_hooks.theme_did_change.append(self._apply_transparency)
        self.apply_config()
        self.web.raise_()

    # ---- layout
    def _apply_transparency(self) -> None:
        self.web.page().setBackgroundColor(QColor(0, 0, 0, 0))

    def apply_config(self) -> None:
        self.cfg = get_config()
        self.web.setFixedSize(int(self.cfg.get("width", 330)), int(self.cfg.get("height", 150)))
        self.web.setWindowOpacity(float(self.cfg.get("opacity", 0.95)))
        self.reposition()
        self.update_visibility()
        self.send({"type": "config", "cfg": {
            "speed": float(self.cfg.get("sim_speed", 1.0)),
            "showMemory": bool(self.cfg.get("show_memory_bar", True)),
            "idleSeconds": int(self.cfg.get("idle_seconds", 60)),
            "sleepSeconds": int(self.cfg.get("sleep_seconds", 240)),
        }})

    def eventFilter(self, obj, evt) -> bool:  # noqa: N802
        if evt.type() in (QEvent.Type.Resize, QEvent.Type.Show, QEvent.Type.Hide, QEvent.Type.Move):
            self.reposition()
        return False

    def reposition(self) -> None:
        host = mw.form.centralwidget
        m = int(self.cfg.get("margin", 12))
        top = mw.toolbarWeb.height() if mw.toolbarWeb.isVisible() else 0
        bottom = mw.bottomWeb.height() if mw.bottomWeb.isVisible() else 0
        w, h = self.web.width(), self.web.height()
        corner = self.cfg.get("corner", "bottom-right")
        x = m if "left" in corner else host.width() - w - m
        y = top + m if "top" in corner else host.height() - h - m - bottom
        self.web.move(max(0, x), max(0, y))
        self.web.raise_()

    def update_visibility(self) -> None:
        enabled = bool(self.cfg.get("enabled", True))
        in_review = mw.state == "review"
        show = enabled and (in_review or bool(self.cfg.get("show_outside_review", True)))
        self.web.setVisible(show)
        if show:
            self.web.raise_()

    # ---- bridge
    def send(self, ev: dict) -> None:
        self.web.eval(f"window.fly && window.fly.event({json.dumps(ev)})")

    def on_cmd(self, cmd: str):
        if cmd == "fly:ready":
            self.load_memory()
            self.apply_config()
            return {"ok": True}
        if cmd.startswith("fly:save:"):
            try:
                os.makedirs(USER_FILES, exist_ok=True)
                tmp = MEMORY_PATH + ".tmp"
                with open(tmp, "w") as f:
                    f.write(cmd[len("fly:save:"):])
                os.replace(tmp, MEMORY_PATH)
            except OSError:
                pass
            return {"ok": True}
        return None

    def load_memory(self) -> None:
        try:
            with open(MEMORY_PATH) as f:
                data = json.load(f)
        except (OSError, ValueError):
            return
        self.send({"type": "loadMemory", "data": data})

    # ---- review events
    def on_question(self, card) -> None:
        self.send({"type": "question", "nid": int(card.nid), "cid": int(card.id)})

    def on_answer_shown(self, card) -> None:
        self.send({"type": "answer"})

    def on_answered(self, reviewer, card, ease: int) -> None:
        self.send({"type": "rate", "ease": int(ease)})

    def on_review_end(self) -> None:
        self.send({"type": "session_end"})

    def on_state(self, new_state, old_state) -> None:
        self.update_visibility()
        self.reposition()
        if new_state == "review" and old_state != "review":
            self.send({"type": "wake"})

    def toggle(self) -> None:
        cfg = get_config()
        cfg["enabled"] = not cfg.get("enabled", True)
        mw.addonManager.writeConfig(__name__, cfg)
        self.apply_config()


def setup() -> None:
    if getattr(mw, "_anki_fly", None):
        return
    fly = FlyWidget()
    mw._anki_fly = fly
    gui_hooks.reviewer_did_show_question.append(fly.on_question)
    gui_hooks.reviewer_did_show_answer.append(fly.on_answer_shown)
    gui_hooks.reviewer_did_answer_card.append(fly.on_answered)
    gui_hooks.reviewer_will_end.append(fly.on_review_end)
    gui_hooks.state_did_change.append(fly.on_state)
    mw.addonManager.setConfigUpdatedAction(__name__, lambda _cfg: fly.apply_config())
    action = QAction("Anki Fly (toggle)", mw)
    action.triggered.connect(fly.toggle)
    mw.form.menuTools.addAction(action)


gui_hooks.main_window_did_init.append(setup)
