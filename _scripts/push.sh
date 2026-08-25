#!/usr/bin/env bash
# 推送原型到 GitHub Pages
set -e
cd "$(dirname "$0")/.."
git add -A
git commit -m "语音触发规则修正：麦克风随抽屉出现，去掉自动开抽屉"
git push
git log --oneline -1
