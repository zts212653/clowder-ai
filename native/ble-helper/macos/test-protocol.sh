#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${SCRIPT_DIR}/.build/$(uname -m)"
OUTPUT="${OUTPUT_DIR}/ble-helper"

mkdir -p "$OUTPUT_DIR"
swiftc \
  -framework CoreBluetooth \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "${SCRIPT_DIR}/Info.plist" \
  "${SCRIPT_DIR}/Protocol.swift" \
  "${SCRIPT_DIR}/BleSupport.swift" \
  "${SCRIPT_DIR}/BleController.swift" \
  "${SCRIPT_DIR}/BleController+Delegates.swift" \
  "${SCRIPT_DIR}/main.swift" \
  -o "$OUTPUT"

REQUESTS="$(mktemp)"
OUTPUT_LOG="$(mktemp)"
trap 'rm -f "$REQUESTS" "$OUTPUT_LOG"' EXIT

printf '%s\n' \
  '{"protocol":"ble-helper","version":1,"requestId":"write-1","command":"gatt.write","params":{"deviceId":"d","valueBase64":"AQ=="}}' \
  '{"protocol":"ble-helper","version":1,"requestId":"stop-1","command":"helper.shutdown","params":{}}' \
  > "$REQUESTS"

"$OUTPUT" --protocol-smoke < "$REQUESTS" > "$OUTPUT_LOG"

grep -q '"kind":"hello"' "$OUTPUT_LOG"
grep -q '"requestId":"write-1"' "$OUTPUT_LOG"
grep -q '"ok":false' "$OUTPUT_LOG"
grep -q '"error":"unsupported_command"' "$OUTPUT_LOG"
grep -q '"requestId":"stop-1"' "$OUTPUT_LOG"
grep -q '"ok":true' "$OUTPUT_LOG"

# The helper must not outlive an API parent that closes stdin unexpectedly.
"$OUTPUT" --protocol-smoke </dev/null >/dev/null 2>&1 &
EOF_PID=$!
for _ in $(seq 1 40); do
  if ! kill -0 "$EOF_PID" 2>/dev/null; then
    break
  fi
  sleep 0.05
done
if kill -0 "$EOF_PID" 2>/dev/null; then
  kill "$EOF_PID" 2>/dev/null || true
  wait "$EOF_PID" 2>/dev/null || true
  echo "BLE helper did not exit after stdin EOF" >&2
  exit 1
fi
wait "$EOF_PID"

echo "BLE helper protocol smoke passed"
