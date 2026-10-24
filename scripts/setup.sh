#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("Node.js 24+ required")'
npm ci --cache /workspace/.npm-cache --no-audit --no-fund
if [ ! -e .env.local ]; then
  install -m 600 .env.example .env.local
fi
NEXT_TELEMETRY_DISABLED=1 npm run build
