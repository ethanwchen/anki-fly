# Drosophil-Anki

A fruit fly whose brain is a real slice of the MaleCNS connectome, studying alongside you.

- `enabled`: show the fly.
- `corner`: `bottom-right`, `bottom-left`, `top-right`, `top-left`.
- `width`, `height`, `margin`: widget size and distance from the corner, in pixels.
- `opacity`: 0–1.
- `show_outside_review`: keep the fly visible on the deck list / overview too.
- `show_memory_bar`: show the "fly memory" bar for the current card.
- `thought_bubbles`: the fly comments on what just happened in its brain.
- `pacing_nudges`: when your last 20 answers get slower and wronger than the start of the session, the fly suggests a break (at most every 15 minutes).
- `focus_mode`: Deep Focus — no bubbles, no facts, no motion; the fly just quietly studies. `Ctrl+Shift+D` toggles it.
- `sim_speed`: brain time per wall-clock time (1.0 = real time).
- `idle_seconds`: seconds without a review before the fly starts grooming / wandering.
- `sleep_seconds`: seconds without a review before the fly falls asleep.

Everything is also in **Tools → Drosophil-Anki** and in the ⚙ menu on the widget: Deep Focus (`Ctrl+Shift+D`), Fly Exam (`Ctrl+Shift+E`), minimize, hide (`Ctrl+Shift+F`). The fly's learned synapse weights are stored in
`user_files/memory.json` inside the add-on folder; delete it to give the fly amnesia.
