#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This workspace is configured for macOS only." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required. Install Node.js, then run: corepack enable" >&2
  exit 1
fi

APP_PROCESS="ARM-Nator"
pkill -x "$APP_PROCESS" 2>/dev/null || true
pkill -f "Electron.*dist/apps/electron-backend/main.js" 2>/dev/null || true

if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi

pnpm embedded-mpv:runtime
pnpm run build

ELECTRON_BIN="$ROOT_DIR/node_modules/.bin/electron"
MAIN_JS="$ROOT_DIR/dist/apps/electron-backend/main.js"

if [[ ! -x "$ELECTRON_BIN" || ! -f "$MAIN_JS" ]]; then
  echo "The macOS build completed without the expected Electron output." >&2
  exit 1
fi

ELECTRON_IS_DEV=0 nohup "$ELECTRON_BIN" "$MAIN_JS" \
  >"${TMPDIR:-/tmp}/arm-nator-mac.log" 2>&1 &

if [[ "${1:-}" == "--verify" ]]; then
  sleep 3
  if pgrep -f "Electron.*dist/apps/electron-backend/main.js" >/dev/null; then
    echo "ARM-Nator is running."
  else
    echo "ARM-Nator did not remain running. Check ${TMPDIR:-/tmp}/arm-nator-mac.log" >&2
    exit 1
  fi
fi
