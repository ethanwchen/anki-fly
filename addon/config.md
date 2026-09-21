# Drosophil-Anki

A fruit fly whose brain is a real slice of the MaleCNS connectome, studying alongside you.

- `enabled`: show the fly.
- `corner`: `bottom-right`, `bottom-left`, `top-right`, `top-left`.
- `fly_sex`: `male` (MaleCNS brain) or `female` (FlyWire brain, a different real connectome). Each brain keeps its own memory file.
- `fly_team`: up to 6 letters shown as a tag over the fly and on the fly race (e.g. BCM).
- `fly_name`: your fly's name (also: gear menu → Name the fly).
- `width`: widget width in pixels (height is always half); drag the top-left corner of the widget to resize. `margin`: distance from the corner.
- `opacity`: 0–1.
- `show_outside_review`: keep the fly visible on the deck overview and other screens too (never on the deck list itself).
- `show_memory_bar`: show the "fly memory" bar for the current card.
- `thought_bubbles`: the fly comments on what just happened in its brain.
- `pacing_nudges`: when your last 20 answers get slower and wronger than the start of the session, the fly suggests a break (at most every 15 minutes).
- `friends_server`: URL of a friends server (see docs/backend-spec.md in the repo) to show your friends' flies on the deck list. Empty = off. `mock` shows example friends.
- `focus_mode`: Deep Focus — no bubbles, no facts, no motion; the fly just quietly studies. `Ctrl+Shift+D` toggles it.
- `sim_speed`: brain time per wall-clock time (1.0 = real time).
- `idle_seconds`: seconds without a review before the fly starts grooming / wandering.
- `sleep_seconds`: seconds without a review before the fly falls asleep.

Everything is also in **Tools → Drosophil-Anki** and in the ⚙ menu on the widget: Deep Focus (`Ctrl+Shift+D`), Fly Exam (`Ctrl+Shift+E`), minimize, hide (`Ctrl+Shift+F`). The fly's learned synapse weights are stored in
`user_files/memory.json` inside the add-on folder; delete it to give the fly amnesia.
