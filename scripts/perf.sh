#!/bin/sh
# The performance guard: the launcher stays small and starts at once. CI fails when a budget is exceeded,
# so a heavier app is a choice made in the pull request that needs it, never an accident.
#
#   scripts/perf.sh <tinyprobe-app binary> <web folder>
set -eu

APP="$1"
WEB="$2"

# Budgets. Measured on 2026-10-31: launcher 3.47 MB with the page inside, page 111 KB, start 3 ms.
MAX_BINARY=4194304      # 4 MiB
MAX_PAGE=204800         # 200 KiB: the HTML, CSS, JavaScript and icons of web/
MAX_START_MS=50         # --version

failed=0
check() {
  status="ok"
  if [ "$2" -gt "$3" ]; then status="OVER BUDGET"; failed=1; fi
  printf '%-28s %10s %-5s budget %10s %-5s %s\n' "$1" "$2" "$4" "$3" "$4" "$status"
}

size=$(wc -c < "$APP" | tr -d ' ')
check "launcher size" "$size" "$MAX_BINARY" "bytes"

page=$(find "$WEB" -type f -exec cat {} + | wc -c | tr -d ' ')
check "page size" "$page" "$MAX_PAGE" "bytes"

# The best of five starts: the first one also pays for the disk cache.
best=999999
for _ in 1 2 3 4 5; do
  start=$(date +%s%N)
  "$APP" --version >/dev/null
  end=$(date +%s%N)
  ms=$(( (end - start) / 1000000 ))
  [ "$ms" -lt "$best" ] && best=$ms
done
check "start-up (--version)" "$best" "$MAX_START_MS" "ms"

exit "$failed"
