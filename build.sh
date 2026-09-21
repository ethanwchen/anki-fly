#!/usr/bin/env bash
# Build dist/anki-fly.ankiaddon (a zip of the addon/ folder contents, without the folder itself).
set -e
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/anki-fly.ankiaddon
( cd addon && zip -q -r ../dist/anki-fly.ankiaddon . -x '*/__pycache__/*' '*.pyc' '.DS_Store' '*/.DS_Store' 'meta.json' 'user_files/memory.json*' )
ls -la dist/anki-fly.ankiaddon
unzip -l dist/anki-fly.ankiaddon | tail -1
