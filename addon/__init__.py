"""Anki Fly: a connectome-driven fruit fly that studies with you.

The simulation and rendering live in web/ (JavaScript, inside an AnkiWebView). This module
positions the widget, forwards review events, persists the fly's memory, and hosts the Fly Exam.
"""
from __future__ import annotations

import functools
import json
import os
import traceback

from aqt import gui_hooks, mw
from aqt.qt import QAction, QColor, QEvent, QKeySequence, QObject, Qt, QUrl
from aqt.webview import AnkiWebView

from . import exam

PKG = mw.addonManager.addonFromModule(__name__)
ADDON_DIR = os.path.dirname(os.path.abspath(__file__))
USER_FILES = os.path.join(ADDON_DIR, "user_files")
MEMORY_PATH = os.path.join(USER_FILES, "memory.json")
STATE_PATH = os.path.join(USER_FILES, "state.json")   # runtime toggles (minimized, focus); config.json keeps the defaults
MINI_SIZE = 44

mw.addonManager.setWebExports(__name__, r"web/.*")

try:
    log = mw.addonManager.get_logger(__name__)
except Exception:  # very old Anki
    import logging
    log = logging.getLogger(__name__)


def safe(fn):
    """Never let an add-on error reach Anki's error dialog; log it and carry on."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception:
            log.error("anki_fly: %s failed\n%s", fn.__name__, traceback.format_exc())
            return None
    return wrapper



def get_config() -> dict:
    return mw.addonManager.getConfig(__name__) or {}


def write_config(cfg: dict) -> None:
    mw.addonManager.writeConfig(__name__, cfg)


def read_state() -> dict:
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_state(**kv) -> None:
    st = read_state()
    st.update(kv)
    try:
        os.makedirs(USER_FILES, exist_ok=True)
        with open(STATE_PATH, "w") as f:
            json.dump(st, f)
    except OSError:
        pass


def read_memory() -> dict | None:
    try:
        with open(MEMORY_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


class FlyWidget(QObject):
    def __init__(self) -> None:
        super().__init__(mw)
        self.cfg = get_config()
        st = read_state()
        self.minimized = bool(st.get("minimized", False))
        self.focus = bool(st.get("focus", self.cfg.get("focus_mode", False)))
        self.closed_this_session = False
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

    def _version(self) -> str:
        try:
            with open(os.path.join(ADDON_DIR, "manifest.json")) as f:
                return str(json.load(f).get("human_version", ""))
        except Exception:
            return ""

    def _refresh_if_updated(self, key: str, web: AnkiWebView) -> bool:
        """After an add-on update, reload this page bypassing Chromium's cache (Anki's media server sends
        max-age=3600 for add-on files). Only touches our own page. Returns True if a reload was triggered."""
        version = self._version()
        if read_state().get(key) == version:
            return False
        write_state(**{key: version})
        try:
            from aqt.qt import QWebEnginePage
            web.page().triggerAction(QWebEnginePage.WebAction.ReloadAndBypassCache)
            return True
        except Exception:
            return False

    # ---- layout
    @safe
    def _apply_transparency(self) -> None:
        self.web.page().setBackgroundColor(QColor(0, 0, 0, 0))

    @safe
    def apply_config(self) -> None:
        self.cfg = get_config()
        if self.minimized:
            self.web.setFixedSize(MINI_SIZE, MINI_SIZE)
        else:
            self.web.setFixedSize(int(self.cfg.get("width", 400)), int(self.cfg.get("height", 150)))
        self.reposition()
        self.update_visibility()
        self.send({"type": "config", "cfg": {
            "speed": float(self.cfg.get("sim_speed", 1.0)),
            "showMemory": bool(self.cfg.get("show_memory_bar", True)),
            "idleSeconds": int(self.cfg.get("idle_seconds", 60)),
            "sleepSeconds": int(self.cfg.get("sleep_seconds", 240)),
            "minimized": self.minimized,
            "bubbles": bool(self.cfg.get("thought_bubbles", True)),
            "focus": self.focus,
            "pacing": bool(self.cfg.get("pacing_nudges", True)),
            "name": str(self.cfg.get("fly_name", "") or ""),
            "width": int(self.cfg.get("width", 400)),
        }})

    def eventFilter(self, obj, evt) -> bool:  # noqa: N802
        try:
            if evt.type() in (QEvent.Type.Resize, QEvent.Type.Show, QEvent.Type.Hide, QEvent.Type.Move):
                self.reposition()
        except Exception:
            pass
        return False

    @safe
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
        # too small to fit: hide rather than cover the reviewer
        self.too_small = host.width() < w + 2 * m or host.height() < h + top + bottom + 2 * m
        self.web.setVisible(self._should_show())
        self.web.raise_()

    def _should_show(self) -> bool:
        enabled = bool(self.cfg.get("enabled", True)) and not self.closed_this_session
        in_review = mw.state == "review"
        return enabled and not getattr(self, "too_small", False) and (in_review or bool(self.cfg.get("show_outside_review", True)))

    @safe
    def update_visibility(self) -> None:
        show = self._should_show()
        self.web.setVisible(show)
        if show:
            self.web.raise_()

    @safe
    def set_minimized(self, value: bool) -> None:
        self.minimized = value
        write_state(minimized=value)
        self.apply_config()

    @safe
    def set_focus(self, value: bool) -> None:
        self.focus = value
        write_state(focus=value)
        self.apply_config()
        from aqt.utils import tooltip
        tooltip("Deep Focus on — the fly will stay quiet." if value else "Deep Focus off.", period=1500)

    @safe
    def toggle_focus(self) -> None:
        self.set_focus(not self.focus)

    @safe
    def rename(self) -> None:
        from aqt.utils import getText
        current = get_config().get("fly_name", "") or ""
        name, ok = getText("What is your fly's name?", default=current, title="Drosophil-Anki")
        if not ok:
            return
        cfg = get_config()
        cfg["fly_name"] = name.strip()[:24]
        write_config(cfg)
        self.apply_config()

    @safe
    def sync_history(self) -> None:
        """Replay the collection's review history into the fly's brain (aggregated per note)."""
        from aqt.utils import askUser, tooltip
        if not mw.col:
            return
        rows = mw.col.db.all(
            "select c.nid, r.ease, r.id from revlog r join cards c on c.id = r.cid "
            "where r.ease > 0 and r.type in (0, 1, 2) order by r.id desc limit 500000")
        rows.reverse()
        if not rows:
            tooltip("No review history yet. The fly shrugs.")
            return
        notes: dict[int, dict] = {}
        for nid, ease, rid in rows:
            n = notes.setdefault(int(nid), {"nid": int(nid), "n": 0, "again": 0, "hard": 0, "good": 0, "easy": 0, "last": 0})
            n["n"] += 1
            n[("again", "hard", "good", "easy")[max(1, min(4, ease)) - 1]] += 1
            n["last"] = int(rid // 1000)
        items = sorted(notes.values(), key=lambda x: -x["last"])[:10000]
        if not askUser(f"Replay {len(rows):,} reviews of {len(items):,} notes into the fly's brain?\n\n"
                       "This takes a few seconds and adds to what it already remembers."):
            return
        self.send({"type": "sync", "notes": items, "reviews": len(rows)})

    @safe
    def toggle_visible(self) -> None:
        """Ctrl+Shift+F / Tools menu: hide for this session, or bring back (and un-minimize)."""
        if self.closed_this_session or self.minimized or not self.web.isVisible():
            self.closed_this_session = False
            self.set_minimized(False)
            if getattr(self, "too_small", False):
                from aqt.utils import tooltip
                tooltip("The Anki window is too small for the fly; make it bigger.", period=2500)
        else:
            self.closed_this_session = True
            self.update_visibility()

    # ---- bridge
    @safe
    def send(self, ev: dict) -> None:
        from aqt.qt import sip
        if sip.isdeleted(self.web):
            return
        self.web.eval(f"window.fly && window.fly.event({json.dumps(ev)})")

    @safe
    def on_cmd(self, cmd: str):
        if cmd == "fly:ready":
            if self._refresh_if_updated("version", self.web):
                return {"ok": True}      # page reloads and will announce itself again
            self.load_memory()
            self.apply_config()
            return {"ok": True}
        if cmd == "fly:minimize":
            self.set_minimized(True)
            return {"ok": True}
        if cmd == "fly:restore":
            self.set_minimized(False)
            return {"ok": True}
        if cmd == "fly:focus:on":
            self.set_focus(True)
            return {"ok": True}
        if cmd == "fly:focus:off":
            self.set_focus(False)
            return {"ok": True}
        if cmd.startswith("fly:resize:") or cmd.startswith("fly:resized:"):
            try:
                w = max(200, min(900, int(cmd.split(":")[2])))
            except ValueError:
                return None
            h = w // 2
            if not self.minimized:
                self.web.setFixedSize(w, h)
                self.reposition()
            if cmd.startswith("fly:resized:"):
                cfg = get_config()
                cfg["width"], cfg["height"] = w, h
                write_config(cfg)
                self.cfg = cfg
            return {"ok": True}
        if cmd == "fly:rename":
            self.rename()
            return {"ok": True}
        if cmd.startswith("fly:leeches:"):
            nids = [n for n in cmd[len("fly:leeches:"):].split(",") if n.isdigit()]
            if nids and mw.col:
                from aqt import dialogs
                b = dialogs.open("Browser", mw)
                b.search_for("nid:" + ",".join(nids[:500]))
            return {"ok": True}
        if cmd == "fly:close":
            self.closed_this_session = True
            self.update_visibility()
            return {"ok": True}
        if cmd == "fly:exam":
            exam.open_exam_dialog()
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

    @safe
    def load_memory(self) -> None:
        data = read_memory()
        if data:
            self.send({"type": "loadMemory", "data": data})

    # ---- review events
    @safe
    def on_question(self, card) -> None:
        deck = mw.col.decks.name(card.current_deck_id()) if mw.col else ""
        self.send({"type": "question", "nid": int(card.nid), "cid": int(card.id), "deck": deck,
                   "reps": int(card.reps), "lapses": int(card.lapses), "ivl": int(card.ivl)})

    @safe
    def on_answer_shown(self, card) -> None:
        self.send({"type": "answer"})

    @safe
    def on_answered(self, reviewer, card, ease: int) -> None:
        try:
            ms = int(card.time_taken())
        except Exception:
            ms = 0
        self.send({"type": "rate", "ease": int(ease), "ms": ms, "ivl": int(card.ivl)})

    @safe
    def on_review_end(self) -> None:
        self.send({"type": "session_end"})

    @safe
    def on_state(self, new_state, old_state) -> None:
        self.update_visibility()
        self.reposition()
        if new_state == "review" and old_state != "review":
            self.send({"type": "wake"})


@safe
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

    menu = mw.form.menuTools.addMenu("Drosophil-Anki")
    toggle = QAction("Show / hide the fly", mw)
    toggle.setShortcut(QKeySequence("Ctrl+Shift+F"))
    toggle.setShortcutContext(Qt.ShortcutContext.ApplicationShortcut)
    toggle.triggered.connect(fly.toggle_visible)
    menu.addAction(toggle)
    focus = QAction("Deep Focus (fly stays quiet)", mw)
    focus.setShortcut(QKeySequence("Ctrl+Shift+D"))
    focus.setShortcutContext(Qt.ShortcutContext.ApplicationShortcut)
    focus.triggered.connect(fly.toggle_focus)
    menu.addAction(focus)
    test = QAction("Fly Exam: test the fly on your cards…", mw)
    test.setShortcut(QKeySequence("Ctrl+Shift+E"))
    test.setShortcutContext(Qt.ShortcutContext.ApplicationShortcut)
    test.triggered.connect(exam.open_exam_dialog)
    menu.addAction(test)
    sync = QAction("Sync the fly with my review history…", mw)
    sync.triggered.connect(fly.sync_history)
    menu.addAction(sync)
    amnesia = QAction("Give the fly amnesia (reset its memory)", mw)
    amnesia.triggered.connect(lambda: _amnesia(fly))
    menu.addAction(amnesia)
    # profile switches: memory is per add-on, but the review state resets
    gui_hooks.profile_did_open.append(lambda: fly.send({"type": "session_end"}))


@safe
def _amnesia(fly: FlyWidget) -> None:
    from aqt.utils import askUser, tooltip
    if not askUser("Wipe everything the fly has learned about your cards?"):
        return
    try:
        os.remove(MEMORY_PATH)
    except OSError:
        pass
    fly.send({"type": "amnesia"})
    tooltip("The fly stares blankly. It remembers nothing.")


gui_hooks.main_window_did_init.append(setup)
