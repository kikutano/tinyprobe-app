#!/bin/sh
# End-to-end checks: the launcher on a copy of tinyprobe's docs/example, with a real tinyprobe and its test
# server, driven through the page's routes as the browser does.
#
#   scripts/e2e.sh <tinyprobe-app binary> <tinyprobe binary> <tinyprobe docs folder> <test server URL>
#
# Needs curl and python3 (to read JSON).
set -eu

APP=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
TINYPROBE="$2"
DOCS="$3"
SERVER="$4"
PORT=47471
BASE="http://127.0.0.1:$PORT"

WORK=$(mktemp -d)
LAUNCHER=""
cleanup() {
  [ -n "$LAUNCHER" ] && kill "$LAUNCHER" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "e2e: $*" >&2; [ -f "$WORK/out.txt" ] && sed 's/^/  launcher: /' "$WORK/out.txt" >&2; exit 1; }
ok() { echo "  ✓ $*"; }
json() { python3 -c "import json, sys; d = json.load(sys.stdin); print($1)"; }

# A copy: the checks write a new endpoint into it.
cp -R "$DOCS" "$WORK/docs"
python3 - "$WORK/docs/environment.yaml" "$SERVER" <<'EOF'
import re, sys
path, server = sys.argv[1], sys.argv[2]
text = open(path).read()
open(path, "w").write(re.sub(r"(?m)^baseUrl:.*$", f"baseUrl: {server}", text))
EOF
ROOT=$(cd "$WORK/docs" && pwd -P)
mkdir -p "$WORK/data"

TINYPROBE_APP_DATA="$WORK/data" TINYPROBE_PATH="$TINYPROBE" "$APP" "$ROOT" --no-open --port "$PORT" > "$WORK/out.txt" 2>&1 &
LAUNCHER=$!
i=0
until grep -q 'it works once' "$WORK/out.txt" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 50 ] || fail "the launcher did not start"
  sleep 0.1
done
LINK=$(grep -o "$BASE/open?t=[^ ]*" "$WORK/out.txt")
JAR="$WORK/cookies"
ORIGIN="Origin: $BASE"
TYPE="Content-Type: application/json"
q() { python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$1"; }
post() { curl -s -b "$JAR" -H "$ORIGIN" -H "$TYPE" -d "$2" "$BASE$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "Session"
[ "$(code -c "$JAR" "$LINK")" = 302 ] || fail "the link did not open a session"
grep -q 'tinyprobe_app' "$JAR" || fail "no session cookie"
if curl -s -D - -o /dev/null "$LINK" | grep -qi '^set-cookie'; then fail "the link worked twice"; fi
ok "the link opens a session once"

echo "Security"
[ "$(code "$BASE/api/state")" = 401 ] || fail "no cookie was accepted"
[ "$(code -b "$JAR" -H 'Host: evil.example' "$BASE/api/state")" = 403 ] || fail "another Host was accepted"
[ "$(code -b "$JAR" -H "$TYPE" -d "{\"root\":\"$ROOT\"}" "$BASE/api/run")" = 403 ] || fail "a POST without Origin was accepted"
[ "$(code -b "$JAR" -H 'Origin: https://evil.example' -H "$TYPE" -d "{\"root\":\"$ROOT\"}" "$BASE/api/run")" = 403 ] || fail "another Origin was accepted"
[ "$(code -b "$JAR" "$BASE/api/file?root=$(q "$ROOT")&path=..%2F..%2Fetc%2Fpasswd")" = 403 ] || fail "a path outside the folder was read"
[ "$(code -b "$JAR" "$BASE/api/file?root=%2Fetc&path=passwd")" = 403 ] || fail "a folder that is not open was read"
ok "no cookie, another Host, another Origin, ../ and a folder not opened are refused"

echo "State and folder"
curl -s -b "$JAR" "$BASE/api/state" | json "d['tinyprobe']['source'], d['folders'][0]['path'] == '$ROOT'" | grep -q "env True" || fail "state"
FOLDER=$(curl -s -b "$JAR" "$BASE/api/folder?root=$(q "$ROOT")")
echo "$FOLDER" | json "sorted({f['inspect']['kind'] for f in d['files']}), all(f['inspect']['valid'] for f in d['files']), d['environments']" \
  | grep -q "\['api', 'sequence', 'workflow'\] True \['environment.yaml'\]" || fail "folder: $(echo "$FOLDER" | head -c 300)"
ok "$(echo "$FOLDER" | json "len(d['files'])") tinyprobe files, all valid, with their kinds"

echo "Call and runs"
post /api/call "{\"root\":\"$ROOT\",\"file\":\"example/api/testserver.yaml\",\"endpoint\":\"status\",\"with\":[{\"name\":\"code\",\"value\":\"404\"}],\"env\":\"environment.yaml\"}" > "$WORK/call.ndjson"
grep -q '"status":404' "$WORK/call.ndjson" && grep -q '"app":"exit","code":0' "$WORK/call.ndjson" || fail "call: $(cat "$WORK/call.ndjson")"
ok "call status code=404 streams its events, then exit code 0"

post /api/run "{\"root\":\"$ROOT\",\"files\":[\"example/workflows/users.yaml\"],\"to\":2,\"env\":\"environment.yaml\"}" > "$WORK/to.ndjson"
[ "$(grep -c '"event":"step_completed"' "$WORK/to.ndjson")" = 2 ] && grep -q '"event":"run_finished","success":true' "$WORK/to.ndjson" || fail "run --to: $(cat "$WORK/to.ndjson" | head -c 400)"
ok "run users.yaml up to step 2"

post /api/run "{\"root\":\"$ROOT\",\"files\":[],\"env\":\"environment.yaml\"}" > "$WORK/all.ndjson"
tail -2 "$WORK/all.ndjson" | head -1 | json "d['event'], d['success'], d['summary']['failed_workflows']" | grep -q "suite_finished True 0" || fail "run all: $(tail -c 600 "$WORK/all.ndjson")"
ok "run all: $(tail -2 "$WORK/all.ndjson" | head -1 | json "d['summary']['total_workflows']") workflows passed"

echo "New request"
python3 - "$ROOT/example/api/testserver.yaml" "$ROOT" > "$WORK/save.json" <<'EOF'
import json, sys
text = open(sys.argv[1]).read()
added = text + "  e2e_user:\n    path: /api/users/${id}\n    auth: bearer\n    params:\n      id: 1\n"
print(json.dumps({"root": sys.argv[2], "path": "example/api/testserver.yaml", "text": added, "basis": text}))
EOF
curl -s -b "$JAR" -H "$ORIGIN" -H "$TYPE" --data "@$WORK/save.json" "$BASE/api/save" | json "d['saved']" | grep -q True || fail "save"
"$TINYPROBE" call "$ROOT/example/api/testserver.yaml" e2e_user -e "$ROOT/environment.yaml" --var "baseUrl=$SERVER" --with token=x --no-color | grep -q 'e2e_user' || fail "the saved endpoint does not run with tinyprobe"
ok "a saved endpoint runs with tinyprobe call"

python3 -c "import json; d = json.load(open('$WORK/save.json')); d['basis'] = d['text']; d['text'] = d['text'] + '  broken:\n    path: /x\n    auth: nope\n'; print(json.dumps(d))" > "$WORK/broken.json"
BEFORE=$(cksum < "$ROOT/example/api/testserver.yaml")
curl -s -b "$JAR" -H "$ORIGIN" -H "$TYPE" --data "@$WORK/broken.json" "$BASE/api/save" | json "d['saved'], d['inspect']['errors'][0]['message']" | grep -q "False unknown auth 'nope'" || fail "an invalid save was kept"
[ "$(cksum < "$ROOT/example/api/testserver.yaml")" = "$BEFORE" ] || fail "the file was not restored"
ok "a save that tinyprobe rejects leaves the file as it was"

echo "Second start"
TINYPROBE_APP_DATA="$WORK/data" "$APP" --no-open > "$WORK/second.txt" 2>&1 || fail "the second start failed"
grep -q "already running: $BASE/open?t=" "$WORK/second.txt" || fail "the second start did not hand over: $(cat "$WORK/second.txt")"
ok "a second start opens the running app"

echo "Stop"
kill -TERM "$LAUNCHER"
i=0
while kill -0 "$LAUNCHER" 2>/dev/null; do
  i=$((i + 1)); [ "$i" -lt 50 ] || fail "the launcher did not stop"
  sleep 0.1
done
LAUNCHER=""
[ ! -f "$WORK/data/instance.json" ] || fail "instance.json was left behind"
ok "it stops on SIGTERM and removes instance.json"

echo "Install"
mkdir -p "$WORK/xdg"
XDG_DATA_HOME="$WORK/xdg" TINYPROBE_APP_DATA="$WORK/installed" TINYPROBE_PATH="$TINYPROBE" "$APP" --install > "$WORK/install.txt" 2>&1 || fail "--install: $(cat "$WORK/install.txt")"
[ -x "$WORK/installed/app/tinyprobe-app" ] || fail "--install did not copy the app"
grep -q "^Exec=\"$WORK/installed/app/tinyprobe-app\"$" "$WORK/xdg/applications/tinyprobe-app.desktop" || fail "--install did not add the menu entry"
grep -q '"shortcut":"created"' "$WORK/installed/config.json" || fail "--install did not record the icon"
ok "--install copies the app, adds the menu entry and records it"

echo "All end-to-end checks passed."
