#!/usr/bin/env bash
# Prepare functions/venv for local deploy or CI. Must match firebase.json runtime.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/functions"

RUNTIME="$(python3 -c "import json; print(json.load(open('../firebase.json'))['functions'][0]['runtime'])")"

case "$RUNTIME" in
  python310) PY=python3.10 ;;
  python311) PY=python3.11 ;;
  python312) PY=python3.12 ;;
  python313) PY=python3.13 ;;
  python314) PY=python3.14 ;;
  *)
    echo "Unsupported functions runtime in firebase.json: $RUNTIME" >&2
    exit 1
    ;;
esac

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "Missing $PY required for runtime $RUNTIME" >&2
  exit 1
fi

"$PY" -m venv venv
./venv/bin/pip install -r requirements.txt
echo "Prepared functions/venv with $PY ($RUNTIME)"
