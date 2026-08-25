#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
git add pilot-simple/index.html pilot-simple/pilot-simple.js
git commit -m "${1:-update pilot-simple prototype}"
git pull --rebase origin main
git push origin main
