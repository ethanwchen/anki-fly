"""Offscreen smoke test: boot aqt with the add-on installed, fire the review hooks, run exam data collection.

Run:  <venv-with-aqt>/bin/python tests/test_addon.py
"""
import os, sys, tempfile, time, traceback

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ["ANKI_SINGLE_INSTANCE_KEY"] = "anki-fly-test"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
base = tempfile.mkdtemp(prefix="ankifly-")
os.makedirs(os.path.join(base, "addons21"))
os.symlink(os.path.join(ROOT, "addon"), os.path.join(base, "addons21", "anki_fly"))

import aqt, aqt.profiles
aqt.profiles.ProfileManager.setDefaultLang = lambda self, idx=0: self.setLang("en")
app = aqt._run(argv=["anki", "-b", base, "-p", "User 1"], exec=False)
from aqt.qt import QElapsedTimer
def pump(ms):
    t = QElapsedTimer(); t.start()
    while t.elapsed() < ms: app.processEvents()
def wait_until(pred, ms=20000):
    t = QElapsedTimer(); t.start()
    while not pred() and t.elapsed() < ms: app.processEvents()
    assert pred(), "timeout"

mw = aqt.mw
wait_until(lambda: mw.col is not None and mw.state != "startup")
pump(500)
assert getattr(mw, "_anki_fly", None), "add-on did not create the widget"
fly = mw._anki_fly
print("widget:", fly.web.size(), "visible", fly.web.isVisible())

col = mw.col
col.set_config("fsrs", True)   # exercise the FSRS path (memory_state / retrievability)
did = col.decks.id("Test")
m = col.models.by_name("Basic")
for i in range(12):
    n = col.new_note(m); n["Front"] = f"q{i}"; n["Back"] = f"a{i}"; col.add_note(n, did)
col.decks.select(did)
col.sched.reset() if hasattr(col.sched, "reset") else None
# answer some cards through the real scheduler and fire the hooks the reviewer would
from aqt import gui_hooks
answered = 0
for ease in [3, 3, 1, 3, 4, 2, 3, 3]:
    card = col.sched.getCard()
    if not card: break
    card.start_timer()
    gui_hooks.reviewer_did_show_question(card)
    gui_hooks.reviewer_did_show_answer(card)
    col.sched.answerCard(card, ease)
    gui_hooks.reviewer_did_answer_card(mw.reviewer, card, ease)
    answered += 1
    pump(50)
print("answered", answered)
gui_hooks.reviewer_will_end()

from anki_fly import exam
data = exam.collect_cards("deck:Test")
cids = [c["cid"] for c in data["cards"]]
pat = exam.study_pattern(cids)
dr = exam.desired_retention(data["cards"])
print("cards:", len(data["cards"]), "models:", sorted({c["model"] for c in data["cards"]}))
print("pattern:", {k: (round(v, 3) if isinstance(v, float) else v) for k, v in pat.items()})
print("desired retention:", dr)
assert len(data["cards"]) == 12
assert pat["reviews_total"] == answered
print("sample:", [(c["model"], round(c["r"], 3), round(c["stability"], 2)) for c in data["cards"][:6]])
assert any(c["model"] == "fsrs" for c in data["cards"]), "expected FSRS memory states"
# exam dialog constructs without error
dlg = exam.ExamDialog({"cards": data["cards"], "pattern": pat, "desired_retention": dr, "memory": None, "search": "deck:Test", "total_matching": 12})
pump(300)
dlg.close()
# --- regression: the fly race panel must reach the deck list on the very first paint.
# Anki renders the deck list before main_window_did_init, so the hook has to be registered at
# add-on import time. Registering it later shipped broken in 0.2.5 (panel only after navigating).
from aqt.deckbrowser import DeckBrowserContent
content = DeckBrowserContent(tree="", stats="")
gui_hooks.deck_browser_will_render_content(mw.deckBrowser, content)
assert "flyfriends" in content.stats, "fly race panel not injected into the deck browser"

src = open(os.path.join(ROOT, "addon", "__init__.py")).read()
tail = src[src.index("gui_hooks.main_window_did_init.append(setup)"):]
head = src[: src.index("gui_hooks.main_window_did_init.append(setup)")]
assert "\nfriends.setup()" in head, "friends.setup() must run at import time, before the first paint"
print("race panel present at import time")
print("ALL OK")

mw.unloadProfileAndExit()
pump(1500)

