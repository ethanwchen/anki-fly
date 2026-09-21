# AnkiWeb listing (paste into https://ankiweb.net/shared/upload)

**Title** (under 80 chars)

Anki Fly: a fruit fly with a real brain studies with you

**Tags**

Gamification Companion Neuroscience Focus

**Support page**

https://github.com/ethanwchen/anki-fly/issues

**Branches**

Supports 25.02 to current (leave the max open so it shows as "25.02+").

**Description** (Markdown; images must be hosted, e.g. raw.githubusercontent.com)

---

**Anki Fly** puts a tiny fruit fly in the corner of Anki. It sits at a desk and studies your cards with you. Its brain is not a cartoon: it is a slice of the real fruit fly connectome (MaleCNS v1.0, Janelia and Google, 2026) running as a spiking neuron simulation while you review.

![Anki Fly widget](https://raw.githubusercontent.com/ethanwchen/anki-fly/main/docs/widget.png)

**How it works**

- Every card is a smell. Each card activates its own set of olfactory neurons in the fly's brain.
- Your answers are dopamine. Good and Easy fire the fly's reward neurons, Again fires its punishment neurons, and the same learning rule real flies use rewires its synapses. The fly builds its own memory of your deck, and you can watch the neurons fire.
- The fly presses its own Again / Hard / Good / Easy buttons along with you, celebrates streaks, grooms when you stall, and falls asleep at its desk if you leave.
- Hover the brain to see which neuron and neurotransmitter is under your cursor.

**Fly Exam** (Ctrl+Shift+E)

Pick decks or tags and the fly sits an exam on those cards. The score comes from Anki's own FSRS memory model, so it is a real prediction of how much you would recall right now, with the fly's brain mixed in for fun. You also get true retention, again rate, consistency, backlog and study efficiency from your review history, plus a short diagnosis with the research reason behind each flag.

**Not distracting**

- Deep Focus (Ctrl+Shift+D): no bubbles, no motion, the fly just studies quietly.
- Minimize to a tiny fly, or hide it for the session (Ctrl+Shift+F). Everything is in the gear menu on the widget and under Tools > Anki Fly.

**Getting started**

Install, restart Anki, start reviewing. Nothing to configure. Size, corner, opacity and idle timers are in Tools > Add-ons > Config.

**Compatibility**

Anki 25.02 or newer on desktop. Tested on macOS; Windows and Linux should work, please report issues on GitHub. Not available on AnkiDroid or iOS, which do not support add-ons.

**Bugs and feedback**

Please use the GitHub issue tracker rather than the reviews: https://github.com/ethanwchen/anki-fly/issues

**Credits**

Connectome data from MaleCNS v1.0 (CC BY 4.0). Neuron model after Shiu et al. 2024. Fly body from the flybody project (Apache 2.0). Source and license (MIT): https://github.com/ethanwchen/anki-fly

If the fly makes your reviews a little nicer, a thumbs up helps others find it.
