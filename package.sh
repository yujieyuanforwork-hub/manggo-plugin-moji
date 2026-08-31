#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$ROOT/dist"
OUT_FILE="$OUT_DIR/io.github.yujieyuanforwork-hub.moji-dict.mplugin"
FILES=(manggo.plugin.json main.js icon.png README.md)

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"
cd "$ROOT"

find_python() {
  local candidate
  for candidate in python3 python py; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "import zipfile" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if command -v zip >/dev/null 2>&1; then
  zip -r "$OUT_FILE" "${FILES[@]}"
elif PYTHON="$(find_python)"; then
  # Windows Git Bash 通常没有 zip，改用 Python 的 zipfile。
  "$PYTHON" -c '
import sys, zipfile

out, files = sys.argv[1], sys.argv[2:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(name, name)
' "$OUT_FILE" "${FILES[@]}"
else
  echo "需要 zip 或 python 才能打包。" >&2
  exit 1
fi

echo "$OUT_FILE"
