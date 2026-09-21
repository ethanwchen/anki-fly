# Anki Fly — plan

A tiny fruit fly lives in the corner of Anki and studies with you. Its brain is a real
connectome subcircuit (mushroom body + a few behavior circuits) running as a
leaky-integrate-and-fire (LIF) spiking simulation. Your reviews are its sensory input;
your answers are its dopamine. You watch the neurons fire.

## Core mapping (review → fly biology)

| Anki event                          | Fly stimulus                                              | What you see                          |
|-------------------------------------|-----------------------------------------------------------|---------------------------------------|
| Question shown                      | "Odor" = card: hash(note id) selects ~3 antennal-lobe glomeruli; their PNs fire | Antennal lobe + Kenyon cells light up |
| Answer shown                        | nothing new (odor persists)                               | KC activity sustains                   |
| Rated Good/Easy                     | PAM (reward) dopamine pulse                               | PAM cluster flashes green; MB glows    |
| Rated Again                         | PPL1 (punishment) dopamine pulse                          | PPL1 flashes red                       |
| Rated Hard                          | weak PPL1                                                 |                                        |
| Streak of N Good                    | sugar GRN stimulation → proboscis motor neuron            | fly extends proboscis (happy)          |
| Idle > 60 s                         | sensory silence                                           | fly grooms (DNg11), then sleeps        |
| Return from idle / deck opened      | looming stimulus (LC4 → Giant Fiber)                      | fly startles, takes off, lands         |
| Review session ends                 | quiet                                                     | fly wanders                            |

Learning: KC→MBON synapses use the standard dopamine-gated plasticity rule (co-active KC +
dopamine → depress the KC→MBON synapse for that valence). Per-card "fly memory" =
the MBON drive for that card's odor pattern. Weights persist across restarts (eternal studying).

## Architecture

```
anki-fly/
  addon/                       # the .ankiaddon contents
    __init__.py                # registers hooks, creates widget
    manifest.json
    config.json / config.md
    widget.py                  # FlyWidget: frameless corner overlay over mw, AnkiWebView inside
    events.py                  # gui_hooks → JS messages (stim/dopamine/idle)
    web/
      index.html
      fly.js                   # bootstraps sim + renderer
      sim.js                   # LIF engine over CSR subgraph (typed arrays, fixed-step)
      brain_view.js            # canvas: soma positions, spikes as pulses, colored by NT
      fly_sprite.js            # 2D fly with animation states: idle/walk/groom/proboscis/sleep/startle
      data/subgraph.bin        # preprocessed connectome subgraph (few MB)
      data/meta.json           # neuron ids, types, NT, xyz, index ranges for stim groups
  tools/
    extract_subgraph.py        # download public connectome data → subgraph.bin/meta.json
  tests/
    test_sim.mjs               # node tests for the LIF engine (spike propagation, dopamine plasticity)
    test_addon.py              # aqt offscreen smoke test: load add-on, fire hooks, no exceptions
  build.sh                     # produce dist/anki-fly.ankiaddon
```

Simulation runs in JS inside the webview (Anki's bundled Python has no numpy; JS typed
arrays are fast enough for ~10–30k neurons at real-time-ish). Python only forwards events.

LIF parameters (Shiu et al. 2024): tau_m 20 ms, V_rest -52 mV, V_thresh -45 mV, V_reset -52 mV,
refractory 2.2 ms, delay 1.8 ms, w = 0.275 mV × syn_count (sign by NT: ACh +, GABA −, Glu −).

## Milestones

1. Data: extraction script → subgraph.bin + meta.json (PN/KC/MBON/DAN + DN + GRN/MN sets).
2. Sim engine in JS + node tests (odor → KC sparse response; dopamine changes KC→MBON weight).
3. Renderer: brain canvas + fly sprite; state readout from DN/MN rates.
4. Anki add-on: overlay widget, hooks, config, persistence of weights.
5. Test in real Anki (test profile), package .ankiaddon, hand to Ethan for manual testing.
6. Only after Ethan's sign-off: AnkiWeb / GitHub release.
