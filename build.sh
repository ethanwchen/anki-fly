#!/usr/bin/env bash
# Build dist/anki-fly.ankiaddon: a zip of addon/ contents (no top folder, no __pycache__, no user data).
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/anki-fly.ankiaddon
STAGE="$(mktemp -d)"
rsync -a --exclude '__pycache__' --exclude '*.pyc' --exclude '.DS_Store' --exclude '/meta.json' \
      --exclude 'user_files/*' addon/ "$STAGE/"
mkdir -p "$STAGE/user_files" && cp addon/user_files/README.txt "$STAGE/user_files/"
cp backend/PRIVACY.md "$STAGE/PRIVACY.md" 2>/dev/null || true
( cd "$STAGE" && zip -q -X -r "$OLDPWD/dist/anki-fly.ankiaddon" . )
rm -rf "$STAGE"
ls -la dist/anki-fly.ankiaddon
# sanity: the brain data must be inside, the user's config must not
unzip -l dist/anki-fly.ankiaddon | grep -q "web/data/meta.json" || { echo "BUILD ERROR: web/data/meta.json missing"; exit 1; }
unzip -l dist/anki-fly.ankiaddon | grep -q "web/data/female/meta.json" || { echo "BUILD ERROR: female meta.json missing"; exit 1; }
unzip -l dist/anki-fly.ankiaddon | grep -E "__pycache__| meta.json$|user_files/(memory|state)" && { echo "BUILD ERROR: private files in zip"; exit 1; }
echo "package ok: $(unzip -l dist/anki-fly.ankiaddon | tail -1)"
