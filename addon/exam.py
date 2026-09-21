"""Fly Exam: the fly sits an exam on a set of your cards.

Python gathers per-card memory data from Anki (FSRS memory state / retrievability, review log
timing, lapses) and study-pattern aggregates; the web page (web/exam.html) runs the fly's brain
over the cards and renders the report.
"""
from __future__ import annotations

import json
import math
import os
import time

from aqt import mw
from aqt.qt import (QCheckBox, QDialog, QDialogButtonBox, QHBoxLayout, QLabel, QLineEdit,
                    QListWidget, QListWidgetItem, QPushButton, Qt, QUrl, QVBoxLayout)
from aqt.utils import showInfo
from aqt.webview import AnkiWebView

PKG = mw.addonManager.addonFromModule(__name__)
DAY_S = 86400
# FSRS retrievability, same form as fsrs-rs `current_retrievability` (decay stored positive:
# 0.5 for FSRS-4.5/5 reproduces the 19/81 curve; FSRS-6 learns it per user, typically < 0.2).
FSRS5_DEFAULT_DECAY = 0.5


def _retrievability(stability: float, elapsed_days: float, decay: float) -> float:
    if stability <= 0:
        return 0.0
    factor = 0.9 ** (-1 / decay) - 1
    return (1 + factor * max(0.0, elapsed_days) / stability) ** (-decay)


def _deck_decay(did: int) -> float:
    """Fallback when the card has no decay: FSRS-6 presets store it as w20; else FSRS-5 default."""
    try:
        conf = mw.col.decks.config_dict_for_deck_id(did)
        params = conf.get("fsrsParams6") or []
        if len(params) >= 21:
            return float(params[20])
    except Exception:
        pass
    return FSRS5_DEFAULT_DECAY


def collect_cards(search: str, limit: int = 2000) -> dict:
    col = mw.col
    now = time.time()
    today = col.sched.today
    cids = col.find_cards(search)
    cards = []
    decay_cache: dict[int, float] = {}
    for cid in cids[:limit]:
        try:
            c = col.get_card(cid)
        except Exception:
            continue
        did = c.current_deck_id()
        if did not in decay_cache:
            decay_cache[did] = _deck_decay(did)
        ms = c.memory_state
        stability = float(ms.stability) if ms else 0.0
        difficulty = float(ms.difficulty) if ms else 0.0
        last_review = getattr(c, "last_review_time", None)
        if not last_review:
            try:
                lr = col.db.scalar("select max(id) from revlog where cid = ? and ease > 0", cid)
                last_review = lr / 1000 if lr else None
            except Exception:
                pass
        elapsed = (now - last_review) / DAY_S if last_review else 0.0
        decay = getattr(c, "decay", None) or decay_cache[did]
        if c.type == 0:           # new card
            r, model = 0.0, "new"
        elif ms and stability > 0:
            r, model = _retrievability(stability, elapsed, decay), "fsrs"
        elif c.ivl > 0:           # SM-2 heuristic: assume 90% retention at the scheduled interval
            r, model = 0.9 ** (elapsed / max(1, c.ivl)), "sm2"
        else:
            r, model = 0.5, "learning"
        try:
            note = c.note()
            front = note.fields[0] if note.fields else ""
        except Exception:
            front = ""
        cards.append({
            "cid": cid, "nid": int(c.nid), "front": _strip(front)[:80],
            "deck": col.decks.name(did), "type": c.type, "queue": c.queue,
            "ivl": c.ivl, "reps": c.reps, "lapses": c.lapses,
            "due_days": (c.due - today) if c.type == 2 else None,
            "stability": stability, "difficulty": difficulty,
            "elapsed": elapsed, "r": r, "model": model,
            "desired_retention": getattr(c, "desired_retention", None),
        })
    return {"cards": cards, "total_matching": len(cids), "search": search, "limit": limit}


def _strip(html: str) -> str:
    import re
    return re.sub(r"<[^>]+>", " ", html).replace("&nbsp;", " ").strip()


def study_pattern(cids: list[int]) -> dict:
    """Aggregates over the review log for these cards (last 30 / 90 days) and overall."""
    col = mw.col
    if not cids:
        return {}
    now_ms = int(time.time() * 1000)
    d30 = now_ms - 30 * DAY_S * 1000
    d90 = now_ms - 90 * DAY_S * 1000
    ids = ",".join(str(c) for c in cids)
    def q(sql, *args):
        return col.db.first(sql.replace("{cids}", ids), *args)
    # "rated and affects scheduling" = ease > 0 and not cramming in a filtered deck (Anki's definition)
    rated = "cid in ({cids}) and ease > 0 and not (type = 3 and factor = 0)"
    # true retention (rslib stats/graphs/retention.rs): review-type entries or any with lastIvl >= 1 day
    tr_where = rated + " and (type = 1 or lastIvl <= -86400 or lastIvl >= 1)"
    total = q(f"select count(), sum(time), sum(ease = 1) from revlog where {rated}")
    r30 = q(f"select count(), sum(time), sum(ease = 1), sum(ease = 4), sum(ease = 1 and type = 1), sum(type = 1) from revlog where {rated} and id > ?", d30)
    tr30 = q(f"select sum(ease > 1), count(), sum(ease > 1 and lastIvl >= 21), sum(lastIvl >= 21) from revlog where {tr_where} and id > ?", d30)
    tr90 = q(f"select sum(ease > 1), count() from revlog where {tr_where} and id > ?", d90)
    day_origin = col.sched.day_cutoff - DAY_S  # start of today (rollover-adjusted), seconds
    days30 = q(f"select count(distinct (id / 1000 - ?) / ?) from revlog where {rated} and id > ?", day_origin - 29 * DAY_S, DAY_S, d30)
    mature_secs = q(f"select avg(time) from revlog where {rated} and type = 1 and lastIvl >= 21 and id > ?", d90)
    young_easy = q(f"select sum(ease = 4), count() from revlog where {rated} and type = 1 and lastIvl < 21 and id > ?", d90)
    first_rev = q(f"select min(id) from revlog where {rated}")
    overdue = col.db.scalar(f"select count() from cards where id in ({ids}) and queue = 2 and due < ?", col.sched.today)
    review_cards = col.db.scalar(f"select count() from cards where id in ({ids}) and queue = 2")
    return {
        "reviews_total": total[0] or 0, "minutes_total": (total[1] or 0) / 60000, "again_total": total[2] or 0,
        "reviews_30d": r30[0] or 0, "minutes_30d": (r30[1] or 0) / 60000, "again_30d": r30[2] or 0, "easy_30d": r30[3] or 0,
        "again_rate_review_30d": (r30[4] / r30[5]) if r30[5] else None,
        "true_retention_30d": (tr30[0] / tr30[1]) if tr30[1] else None,
        "true_retention_mature_30d": (tr30[2] / tr30[3]) if tr30[3] else None,
        "true_retention_n_30d": tr30[1] or 0,
        "review_cards": review_cards or 0,
        "true_retention_90d": (tr90[0] / tr90[1]) if tr90[1] else None,
        "days_studied_30d": days30[0] or 0,
        "mature_secs_per_review": (mature_secs[0] or 0) / 1000 if mature_secs and mature_secs[0] else None,
        "young_easy_rate": (young_easy[0] / young_easy[1]) if young_easy and young_easy[1] else None,
        "first_review_days_ago": ((now_ms - first_rev[0]) / (DAY_S * 1000)) if first_rev and first_rev[0] else None,
        "overdue": overdue or 0,
        "fsrs_enabled": bool(col.get_config("fsrs", False)),
    }


def desired_retention(cards: list[dict]) -> float | None:
    vals = [c["desired_retention"] for c in cards if c.get("desired_retention")]
    if not vals:
        try:
            dids = {mw.col.get_card(c["cid"]).current_deck_id() for c in cards[:200]}
            vals = [mw.col.decks.config_dict_for_deck_id(d).get("desiredRetention") for d in dids]
            vals = [v for v in vals if v]
        except Exception:
            return None
    return sum(vals) / len(vals) if vals else None


class ExamSetupDialog(QDialog):
    def __init__(self) -> None:
        super().__init__(mw)
        self.setWindowTitle("Fly Exam")
        self.setMinimumWidth(420)
        lay = QVBoxLayout(self)
        lay.addWidget(QLabel("Which cards should the fly be tested on? (no deck selected = all decks)"))
        self.decks = QListWidget()
        self.decks.setSelectionMode(QListWidget.SelectionMode.MultiSelection)
        for d in mw.col.decks.all_names_and_ids(skip_empty_default=True):
            item = QListWidgetItem(d.name)
            item.setData(Qt.ItemDataRole.UserRole, d.id)
            self.decks.addItem(item)
        lay.addWidget(self.decks)
        row = QHBoxLayout()
        row.addWidget(QLabel("Extra search (optional):"))
        self.extra = QLineEdit()
        self.extra.setPlaceholderText("e.g. tag:pharm  or  prop:ivl>21")
        row.addWidget(self.extra)
        lay.addLayout(row)
        self.include_new = QCheckBox("Include new (never studied) cards")
        lay.addWidget(self.include_new)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("Start exam")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        lay.addWidget(buttons)

    def search(self) -> str:
        parts = []
        names = [f'"deck:{i.text()}"' for i in self.decks.selectedItems()]
        if names:
            parts.append("(" + " or ".join(names) + ")")
        if self.extra.text().strip():
            parts.append(self.extra.text().strip())
        if not self.include_new.isChecked():
            parts.append("-is:new")
        parts.append("-is:suspended -is:buried")
        return " ".join(parts)


class ExamDialog(QDialog):
    def __init__(self, payload: dict) -> None:
        super().__init__(mw)
        self.setWindowTitle("Fly Exam")
        self.resize(900, 640)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.web = AnkiWebView(parent=self, title="anki_fly_exam")
        self.web.set_bridge_command(self.on_cmd, self)
        self.web.set_open_links_externally(False)
        self.payload = payload
        self.web.load_url(QUrl(f"{mw.serverURL()}_addons/{PKG}/web/exam.html"))
        lay.addWidget(self.web)

    def on_cmd(self, cmd: str):
        try:
            return self._on_cmd(cmd)
        except Exception:
            return None

    def _on_cmd(self, cmd: str):
        if cmd == "exam:ready":
            self.web.eval(f"window.exam.start({json.dumps(self.payload)})")
            return {"ok": True}
        if cmd == "exam:close":
            self.close()
            return {"ok": True}
        if cmd.startswith("exam:browse:"):
            from aqt.browser import Browser
            from aqt import dialogs
            b = dialogs.open("Browser", mw)
            b.search_for(cmd[len("exam:browse:"):])
            return {"ok": True}
        return None

    def closeEvent(self, evt) -> None:  # noqa: N802
        try:
            self.web.cleanup()
        except Exception:
            pass
        super().closeEvent(evt)


def open_exam_dialog() -> None:
    try:
        _open_exam_dialog()
    except Exception:
        import traceback
        from aqt.utils import showWarning
        try:
            mw.addonManager.get_logger(__name__).exception("Fly Exam failed")
        except Exception:
            pass
        showWarning("Anki Fly: the exam could not be prepared.\n\n" + traceback.format_exc()[-1500:], title="Anki Fly")


def _open_exam_dialog() -> None:
    if not mw.col:
        return
    setup = ExamSetupDialog()
    if setup.exec() != QDialog.DialogCode.Accepted:
        return
    search = setup.search()
    data = collect_cards(search)
    if not data["cards"]:
        showInfo("No cards matched. The fly is relieved.")
        return
    cids = [c["cid"] for c in data["cards"]]
    from . import read_memory
    payload = {
        "cards": data["cards"], "total_matching": data["total_matching"], "search": search,
        "pattern": study_pattern(cids), "desired_retention": desired_retention(data["cards"]),
        "memory": read_memory(), "generated": time.time(),
    }
    dlg = ExamDialog(payload)
    mw._anki_fly_exam = dlg
    dlg.show()
