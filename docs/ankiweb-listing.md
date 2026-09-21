# AnkiWeb listing (paste into https://ankiweb.net/shared/upload)

**Title** (under 80 chars)

Drosophil-Anki: a fruit fly with a real brain studies with you

**Tags**

Gamification Companion Neuroscience Focus

**Support page**

https://github.com/ethanwchen/anki-fly/issues

**Branches**

Minimum 25.02, maximum empty (shows as "25.02+").

**Description** (Markdown)

---

**Drosophil-Anki** puts a tiny fruit fly in the corner of Anki. It studies your cards with you, and its brain is real: a slice of the fruit fly connectome (MaleCNS v1.0, Janelia and Google, 2026) running as a live neuron simulation while you review.

![Drosophil-Anki](https://raw.githubusercontent.com/ethanwchen/anki-fly/main/docs/widget.gif)

- Every card is a smell to the fly. Good and Easy give it reward dopamine, Again gives it punishment dopamine, and its synapses rewire the same way a real fly learns. Watch the neurons fire.
- It presses its own Again / Hard / Good / Easy buttons with you, celebrates streaks, and dozes off at its desk if you leave.
- **Fly Exam** (Ctrl+Shift+E): pick decks and the fly sits an exam on them. The score is Anki's own FSRS prediction of what you would remember right now, in plain words, with retention, again rate and consistency from your review history.
- **Sync** replays your existing review history into the fly's brain.
- **Not distracting**: Deep Focus (Ctrl+Shift+D) keeps it still and silent, or minimize and hide it (Ctrl+Shift+F). Everything is in the gear menu on the widget and under Tools > Drosophil-Anki.

![Fly Exam](https://raw.githubusercontent.com/ethanwchen/anki-fly/main/docs/exam.gif)

Install, restart Anki, start reviewing. Anki 25.02+ on desktop (Mac, Windows, Linux). Tested on macOS; please report issues on GitHub rather than in reviews: https://github.com/ethanwchen/anki-fly/issues

Open source (MIT): https://github.com/ethanwchen/anki-fly. Connectome data CC BY 4.0 (MaleCNS), neuron model after Shiu et al. 2024, fly body from the flybody project.
