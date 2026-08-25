#!/usr/bin/env bash
# 提交并推送 live-copilot-prototype（本目录是独立 git 仓库，指向 GitHub Pages）
# 用法：bash _scripts/push.sh "commit message"
set -e

cd "$(dirname "$0")/.."
git add -A
git commit -m "${1:-prototype: update}"
git push
git log --oneline -1
