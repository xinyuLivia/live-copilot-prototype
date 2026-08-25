#!/usr/bin/env bash
# 推送原型到 GitHub Pages
set -e
cd "$(dirname "$0")/.."
git add -A
git commit -m "兜底文案与 PRD 异常话术对齐"
git push
git log --oneline -1
