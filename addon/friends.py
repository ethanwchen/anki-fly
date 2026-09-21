"""Friends: a panel on the deck list (front page only) showing your fly code and your friends' flies.

Talks to the small backend described in docs/backend-spec.md. Disabled until `friends_server` is set in
the config; `friends_server: "mock"` shows fake friends for trying the panel without a server.
Nothing about cards or decks is ever sent: only name, species, costume, mood and aggregate counts.
"""
from __future__ import annotations

import json
import random
import threading
import time

from aqt import gui_hooks, mw
from aqt.qt import QTimer
from aqt.utils import getText, showInfo, tooltip

from . import get_config, read_state, write_state

PKG = mw.addonManager.addonFromModule(__name__)
HEARTBEAT_S = 30
MOODS = {"study", "pressAgain", "pressHard", "pressGood", "pressEasy", "celebrate", "dance", "zoomies",
         "crashout", "sulk", "sleepDesk", "still", "idle", "offline"}
MOCK_FRIENDS = [
    {"code": "K7Q2M9ZX", "name": "Gerald", "species": "wild", "costume": "sunglasses", "online": True, "mood": "study", "cardsPerMin": 4.2, "lastSeen": 0},
    {"code": "P3XW8AQ4", "name": "Pip", "species": "female", "costume": "partyhat", "online": True, "mood": "dance", "cardsPerMin": 6.1, "lastSeen": 0},
    {"code": "B9NR4TLC", "name": "Drosophilbert", "species": "wild", "costume": "none", "online": False, "mood": "offline", "cardsPerMin": 0, "lastSeen": 3600 * 5},
]


class Friends:
    def __init__(self) -> None:
        self.friends: list[dict] = []
        self.mood = "idle"
        self.session = {"cards": 0, "again": 0, "start": time.time()}
        self.last_error = ""
        self.timer = QTimer(mw)
        self.timer.timeout.connect(self.heartbeat)
        self.timer.start(HEARTBEAT_S * 1000)
        self._lock = threading.Lock()

    # ---- config / identity
    def server(self) -> str:
        return (get_config().get("friends_server") or "").strip().rstrip("/")

    def enabled(self) -> bool:
        return bool(self.server())

    def mock(self) -> bool:
        return self.server() == "mock"

    def identity(self) -> dict:
        st = read_state()
        return {"token": st.get("friends_token"), "code": st.get("friends_code")}

    def profile(self) -> dict:
        cfg = get_config()
        st = read_state()
        prog = st.get("progress") or {}
        return {
            "name": (cfg.get("fly_name") or "my fly")[:24],
            "species": "female" if cfg.get("fly_sex") == "female" else "wild",
            "costume": prog.get("costume") or "none",
        }

    # ---- network (runs in a worker thread; results applied on the main thread)
    def _call(self, method: str, path: str, body: dict | None = None, auth: bool = True) -> dict:
        import requests
        headers = {"Content-Type": "application/json"}
        if auth:
            tok = self.identity()["token"]
            if not tok:
                raise RuntimeError("not registered")
            headers["Authorization"] = f"Bearer {tok}"
        r = requests.request(method, self.server() + path, json=body, headers=headers, timeout=10)
        r.raise_for_status()
        return r.json() if r.text else {}

    def _bg(self, fn, done=None) -> None:
        def run():
            try:
                res = fn()
                err = ""
            except Exception as e:  # network errors are expected sometimes; never raise into Anki
                res, err = None, str(e)[:200]
            def apply():
                self.last_error = err
                if done:
                    done(res)
            mw.taskman.run_on_main(apply)
        threading.Thread(target=run, daemon=True).start()

    def ensure_registered(self, then=None) -> None:
        if not self.enabled():
            return
        if self.mock():
            if not self.identity()["code"]:
                write_state(friends_code="MOCK1234", friends_token="mock")
            if then:
                then()
            return
        if self.identity()["token"]:
            if then:
                then()
            return
        def reg():
            return self._call("POST", "/v1/register", self.profile(), auth=False)
        def done(res):
            if res and res.get("token") and res.get("code"):
                write_state(friends_token=res["token"], friends_code=res["code"])
                if then:
                    then()
        self._bg(reg, done)

    # ---- presence
    def set_mood(self, mood: str) -> None:
        if mood in MOODS:
            self.mood = mood

    def note_answer(self, ease: int) -> None:
        self.session["cards"] += 1
        if ease == 1:
            self.session["again"] += 1

    def heartbeat(self, offline: bool = False) -> None:
        if not self.enabled():
            return
        if self.mock():
            self.friends = [dict(f) for f in MOCK_FRIENDS]
            for f in self.friends:
                f["lastSeen"] = time.time() - (0 if f["online"] else 5 * 3600)
                if f["online"]:
                    f["mood"] = random.choice(["study", "study", "pressGood", "pressAgain", "celebrate", "dance"])
            return
        if not self.identity()["token"]:
            self.ensure_registered(self.heartbeat)
            return
        mins = max(1 / 60, (time.time() - self.session["start"]) / 60)
        body = {**self.profile(), "mood": "offline" if offline else self.mood,
                "cardsPerMin": round(self.session["cards"] / mins, 2),
                "sessionCards": self.session["cards"], "sessionAgain": self.session["again"],
                "race": {"days": len((read_state().get("progress") or {}).get("days") or []),
                         "reviews": self.session["cards"], "trueRetention": None}}
        def done(res):
            if res and isinstance(res.get("friends"), list):
                self.friends = res["friends"]
        self._bg(lambda: self._call("POST", "/v1/heartbeat", body), done)

    # ---- friend management (menu)
    def show_code(self) -> None:
        if not self.enabled():
            showInfo("Friends are off. Set `friends_server` in the add-on config (Tools → Add-ons → Config) to turn them on.")
            return
        def show():
            showInfo(f"Your fly code is:\n\n{self.identity()['code']}\n\nShare it with a friend; they add it under Tools → Drosophil-Anki → Add a friend.")
        self.ensure_registered(show)

    def add_friend(self) -> None:
        if not self.enabled():
            self.show_code()
            return
        code, ok = getText("Friend's fly code:", title="Drosophil-Anki")
        if not ok or not code.strip():
            return
        code = code.strip().upper()
        if self.mock():
            self.friends.append({"code": code, "name": "New friend", "species": "wild", "costume": "none", "online": False, "mood": "offline", "cardsPerMin": 0, "lastSeen": 0})
            tooltip("Friend added (mock).")
            mw.deckBrowser.refresh()
            return
        def done(res):
            if res and res.get("ok"):
                tooltip(f"Added {res.get('friend', {}).get('name', code)}.")
                self.heartbeat()
                mw.deckBrowser.refresh()
            else:
                showInfo("Could not add that code." + (f"\n\n{self.last_error}" if self.last_error else ""))
        self.ensure_registered(lambda: self._bg(lambda: self._call("POST", "/v1/friends", {"code": code}), done))

    def leave(self) -> None:
        if not self.enabled():
            return
        from aqt.utils import askUser
        if not askUser("Leave friends? Your fly code and friend list on the server are deleted."):
            return
        def done(_):
            write_state(friends_token=None, friends_code=None)
            self.friends = []
            tooltip("Left.")
            mw.deckBrowser.refresh()
        if self.mock():
            done(None)
        else:
            self._bg(lambda: self._call("DELETE", "/v1/me"), done)

    # ---- the front-page panel (an iframe so it can render the friends' flies)
    def panel_html(self) -> str:
        if not self.enabled():
            return ""
        return (f'<div style="margin:18px auto 0;max-width:720px">'
                f'<iframe id="flyfriends" src="/_addons/{PKG}/web/friends.html" '
                f'style="width:100%;height:230px;border:0;border-radius:12px;background:transparent" '
                f'title="Fly friends"></iframe></div>')

    def snapshot(self) -> dict:
        me = self.profile()
        me["code"] = self.identity()["code"] or ""
        me["mood"] = self.mood
        return {"me": me, "friends": self.friends, "error": self.last_error, "mock": self.mock(), "now": time.time()}


def setup() -> None:
    fr = Friends()
    mw._anki_fly_friends = fr

    def on_render(deck_browser, content):
        try:
            content.stats += fr.panel_html()
        except Exception:
            pass
    gui_hooks.deck_browser_will_render_content.append(on_render)

    def on_js(handled, message: str, context):
        if not isinstance(message, str) or not message.startswith("flyfriends:"):
            return handled
        cmd = message[len("flyfriends:"):]
        try:
            if cmd == "list":
                return (True, fr.snapshot())
            if cmd == "add":
                fr.add_friend()
            elif cmd == "code":
                fr.show_code()
        except Exception:
            pass
        return (True, None)
    gui_hooks.webview_did_receive_js_message.append(on_js)

    gui_hooks.profile_will_close.append(lambda: fr.heartbeat(offline=True))
    gui_hooks.profile_did_open.append(lambda: fr.ensure_registered(fr.heartbeat))
    fr.ensure_registered(fr.heartbeat)   # the profile is already open when add-ons finish loading
    return fr
