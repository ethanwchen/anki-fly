# Drosophil-Anki

Start by reading `context/README.md` (local, git-ignored): current version, deploy/publish steps, backend,
test harness, gotchas and Ethan's preferences. Detailed research notes are in `context/*.md` and reusable
test scripts in `context/harness/`.

Rules for this repo:
- Never `git add -A` from outside this folder; verify `git rev-parse --show-toplevel` is this directory.
- Bump `addon/manifest.json` human_version, run `./build.sh` (it validates the package), copy the file to
  `~/Desktop/Drosophil-Anki-release/`, then tag `vX.Y.Z` to publish on GitHub. Ethan uploads to AnkiWeb by hand.
- Run `node tests/test_sim.mjs`, `node tests/test_circuits.mjs`, `node tests/test_circuits_female.mjs`
  and (if a venv with aqt exists) `tests/test_addon.py` before a release.
- Short, plain copy; no em dashes in user-facing text.
