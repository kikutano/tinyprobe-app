#!/bin/sh
# Development tasks for tinyprobe-app, the same steps CI runs, on your machine.
#
#   scripts/dev.sh <command>
#
# Commands:
#   build     Build the launcher and its tests (Debug).
#   test      Unit tests: the launcher (dotnet test) and the page's logic (node --test).
#   aot       Publish the Native AOT launcher to publish/, like a release (needs clang or gcc, and zlib).
#   e2e       aot, then scripts/e2e.sh: the launcher on tinyprobe's docs/example, against its test server.
#   perf      aot, then the size and start-up budgets of CI (scripts/perf.sh).
#   check     build + test + e2e + perf: run it before opening a pull request.
#   run       aot, then start the app on your machine (data in .dev/data, so your own settings stay untouched).
#
# Environment variables:
#   TINYPROBE_PATH       the tinyprobe binary (default: tinyprobe on the PATH)
#   TINYPROBE_EXAMPLES   tinyprobe's docs folder, with example/ and environment.yaml (default: ../tinyprobe/docs)
#   TINYPROBE_PORT       port of the test server (default: 5122)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
EXAMPLES="${TINYPROBE_EXAMPLES:-$ROOT/../tinyprobe/docs}"
PORT="${TINYPROBE_PORT:-5122}"

fail() { echo "dev: $*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

rid() {
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin) os="osx" ;;
    *) fail "unsupported OS '$(uname -s)'." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) fail "unsupported architecture '$(uname -m)'." ;;
  esac
  echo "$os-$arch"
}

build() {
  step "Build"
  dotnet build "$ROOT/Tinyprobe.App.slnx" -nologo -v quiet
}

unit_tests() {
  step "Unit tests (launcher)"
  dotnet test "$ROOT/Tinyprobe.App.slnx" --no-build -nologo -v quiet
  step "Unit tests (page)"
  node --test "$ROOT/test/"
}

aot() {
  step "Native AOT ($(rid))"
  dotnet publish "$ROOT/launcher/Tinyprobe.App.csproj" -c Release -r "$(rid)" -o "$ROOT/publish" -nologo -v quiet
  ls -l "$ROOT/publish/tinyprobe-app"
}

tinyprobe_path() {
  if [ -n "${TINYPROBE_PATH:-}" ]; then echo "$TINYPROBE_PATH"; return; fi
  command -v tinyprobe || fail "tinyprobe is not on the PATH: install it, or set TINYPROBE_PATH."
}

# The test server of tinyprobe's examples: the one already running, else from the sources next to this
# repository, else its Docker image. Started servers are stopped at the end.
SERVER_PID=""
SERVER_CONTAINER=""
start_server() {
  if curl -fs "http://localhost:$PORT/api/public" >/dev/null 2>&1; then return; fi
  if [ -d "$ROOT/../tinyprobe/tests/Tinyprobe.RealServer.Tests" ]; then
    step "Start the test server from ../tinyprobe"
    ASPNETCORE_URLS="http://localhost:$PORT" dotnet run --project "$ROOT/../tinyprobe/tests/Tinyprobe.RealServer.Tests" >/dev/null 2>&1 &
    SERVER_PID=$!
  elif command -v docker >/dev/null 2>&1; then
    step "Start the test server image"
    SERVER_CONTAINER=$(docker run -d --rm -p "127.0.0.1:$PORT:5122" ghcr.io/kikutano/tinyprobe-testserver)
  else
    fail "no test server on port $PORT: start it with ../tinyprobe/scripts/dev.sh server, or install Docker."
  fi
  i=0
  until curl -fs "http://localhost:$PORT/api/public" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 90 ] || fail "the test server did not start."
    sleep 1
  done
}

stop_server() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  if [ -n "$SERVER_CONTAINER" ]; then docker stop "$SERVER_CONTAINER" >/dev/null 2>&1 || true; fi
}

e2e() {
  [ -d "$EXAMPLES/example" ] || fail "tinyprobe's examples are not in $EXAMPLES: clone tinyprobe next to this repository, or set TINYPROBE_EXAMPLES."
  trap stop_server EXIT
  start_server
  step "End-to-end"
  "$ROOT/scripts/e2e.sh" "$ROOT/publish/tinyprobe-app" "$(tinyprobe_path)" "$EXAMPLES" "http://localhost:$PORT/"
}

perf() {
  step "Performance guard"
  "$ROOT/scripts/perf.sh" "$ROOT/publish/tinyprobe-app" "$ROOT/web"
}

case "${1:-}" in
  build) build ;;
  test) build; unit_tests ;;
  aot) aot ;;
  e2e) aot; e2e ;;
  perf) aot; perf ;;
  check) build; unit_tests; aot; e2e; perf; step "All checks passed" ;;
  run)
    aot
    mkdir -p "$ROOT/.dev/data"
    TINYPROBE_APP_DATA="$ROOT/.dev/data" "$ROOT/publish/tinyprobe-app" "$@"
    ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
