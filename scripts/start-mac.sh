#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != "Darwin" ]]; then echo "Run this script on macOS."; exit 1; fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "Install Node.js 24 or newer, then run this script again."; exit 1
fi
node -e 'if(Number(process.versions.node.split(".")[0])<24){console.error("Node.js 24+ required");process.exit(1)}'
if [[ ! -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ]]; then
  echo "Installing locked application dependencies (first launch)..."
  npm ci --no-audit --no-fund
fi
unset ELECTRON_RUN_AS_NODE
exec npm start
