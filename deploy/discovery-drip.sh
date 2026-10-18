#!/bin/sh
# 首次填充期的"滴灌"：每轮换一个搜索词排一次自动发现（unauth 时每小时只有 ~60 次核心配额，
# 一轮就吃满，所以只能慢速多轮；配了只读 GITHUB_TOKEN 后可以改成批量）。
#
# 这个脚本只**排任务**，真正的探测/收录由常驻 worker 执行（与每日定时完全同一条路径）。
# 填得差不多就把定时器停掉：systemctl disable --now dsh-review-discovery-drip.timer
set -eu

cd /root/dsh-plugin-review/repo/docker

# 轮换搜索词：不同入口能捞到不同仓库（topic 覆盖不到的，用 in:name / in:description 兜）
QUERIES='
topic:dsh-plugin
dsh-plugin in:name
topic:deepseek-harness
dsh plugin in:description
topic:dsh
'

# 用"每 70 分钟换一个"的节拍选词：不依赖外部状态文件，重启也不会乱。
# 2400 秒 = 40 分钟：实测单轮只花 ~26 次核心请求，40 分钟节拍 ≈ 39 次/小时，安全压在 60/h 之下
slot=$(( $(date +%s) / 2400 ))
count=$(printf '%s\n' "$QUERIES" | grep -c .)
idx=$(( slot % count ))
query=$(printf '%s\n' "$QUERIES" | grep . | sed -n "$((idx + 1))p")

echo "[drip] slot=$slot idx=$idx query=$query"
exec docker compose run --rm --no-deps worker npx tsx scripts/discover-now.mjs \
  --query "$query" --limit 12
