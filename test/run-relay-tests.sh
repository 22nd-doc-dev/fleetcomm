#!/usr/bin/env bash
# Start an isolated disposable Mumble relay and run the real protocol suites.
set -euo pipefail

command -v mumble-server >/dev/null || { echo "mumble-server is required for relay integration tests" >&2; exit 1; }
RELAY_TEST_DIR="$(mktemp -d)"
RELAY_TEST_PID=""
cleanup() {
  if test -n "$RELAY_TEST_PID"; then kill "$RELAY_TEST_PID" >/dev/null 2>&1 || true; fi
  rm -rf "$RELAY_TEST_DIR"
}
trap cleanup EXIT

cat > "$RELAY_TEST_DIR/mumble.ini" << INI
database=$RELAY_TEST_DIR/mumble.sqlite
port=64738
host=127.0.0.1
users=100
opusthreshold=0
allowping=true
bandwidth=144000
autobanAttempts=1000
autobanTimeframe=60
autobanTime=1
messagelimit=10
messageburst=50
logfile=$RELAY_TEST_DIR/mumble.log
INI

mumble-server -ini "$RELAY_TEST_DIR/mumble.ini" -supw devpass123 >/dev/null 2>&1
mumble-server -fg -ini "$RELAY_TEST_DIR/mumble.ini" >"$RELAY_TEST_DIR/stdout.log" 2>&1 &
RELAY_TEST_PID=$!

ready=0
for _ in {1..50}; do
  if node -e 'const n=require("net"),s=n.connect(64738,"127.0.0.1",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1))' 2>/dev/null; then
    ready=1; break
  fi
  sleep 0.1
done
if test "$ready" != 1; then
  cat "$RELAY_TEST_DIR/stdout.log" >&2 || true
  echo "disposable Mumble relay did not start" >&2
  exit 1
fi

npm run test:relay
