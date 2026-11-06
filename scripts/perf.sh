#!/bin/sh
# The performance guard: the launcher stays small and starts at once. CI fails when a budget is exceeded,
# so a heavier app is a choice made in the pull request that needs it, never an accident.
#
#   scripts/perf.sh <tinyprobe-app binary> <web folder>
set -eu

APP="$1"
WEB="$2"

# Budgets. Measured on 2026-10-31: launcher 3.47 MB with the page inside, page 111 KB, start 3 ms.
# The page budget went from 200 to 256 KiB on 2026-11-02: the diagram (M5-3), the visual editor (M5-4) and
# environments made it 210 KB, still a fraction of one image of a typical web app.
MAX_BINARY=4194304      # 4 MiB
# Since 2026-11-06 the page's text files are embedded gzipped (0.4.10): the budget counts what the executable
# carries, the text gzipped and the icons as they are. 253 KB of files were 85 KB in the executable.
MAX_PAGE=131072         # 128 KiB: the page as embedded
MAX_START_MS=50         # --version

failed=0
check() {
  status="ok"
  if [ "$2" -gt "$3" ]; then status="OVER BUDGET"; failed=1; fi
  printf '%-28s %10s %-5s budget %10s %-5s %s\n' "$1" "$2" "$4" "$3" "$4" "$status"
}

size=$(wc -c < "$APP" | tr -d ' ')
check "launcher size" "$size" "$MAX_BINARY" "bytes"

# The text files as the build gzips them (CompressPage in the project), the other files as they are.
page=0
for file in $(find "$WEB" -type f); do
  case "$file" in
    *.html|*.js|*.css|*.svg|*.webmanifest) bytes=$(gzip -6 -c "$file" | wc -c | tr -d ' ') ;;
    *) bytes=$(wc -c < "$file" | tr -d ' ') ;;
  esac
  page=$((page + bytes))
done
check "page size (embedded)" "$page" "$MAX_PAGE" "bytes"

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
