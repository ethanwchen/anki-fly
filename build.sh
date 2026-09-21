#!/usr/bin/env bash
# Build dist/anki-fly.ankiaddon: a zip of addon/ contents (no top folder, no __pycache__, no user data).
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/anki-fly.ankiaddon
STAGE="$(mktemp -d)"
rsync -a --exclude '__pycache__' --exclude '*.pyc' --exclude '.DS_Store' --exclude 'meta.json' \
      --exclude 'user_files/*' addon/ "$STAGE/"
mkdir -p "$STAGE/user_files" && cp addon/user_files/README.txt "$STAGE/user_files/"
cp backend/PRIVACY.md "$STAGE/PRIVACY.md" 2>/dev/null || true
( cd "$STAGE" && zip -q -X -r "$OLDPWD/dist/anki-fly.ankiaddon" . )
rm -rf "$STAGE"
ls -la dist/anki-fly.ankiaddon
unzip -l dist/anki-fly.ankiaddon | grep -E "__pycache__|user_files|meta.json" || echo "clean: no pycache/meta; user_files: README only"
