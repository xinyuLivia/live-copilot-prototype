#!/usr/bin/env bash
# 推送原型到 GitHub Pages
set -e
cd "$(dirname "$0")/.."
git add -A
git commit -m "人工处置：新增处置态与底部收口按钮，处置中支持 AI 代飞；徽标文案对齐 PRD；去掉面板联动高亮"
git push
git log --oneline -1
