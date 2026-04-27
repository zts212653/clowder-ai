#!/usr/bin/env bash
# Temporary: force first-run E2E back to a true zero state.
# Remove this script after final E2E verification.
set -euo pipefail

API="http://localhost:3204"
MAX_WAIT=60
MAX_RESET_PASSES=12

list_cats() {
  curl -sf "$API/api/cats" 2>/dev/null \
    | python3 -c "import sys,json; [print(c['id']) for c in json.load(sys.stdin).get('cats',[])]" 2>/dev/null \
    || true
}

list_bootcamp_threads() {
  curl -sf -H 'x-cat-cafe-user: default-user' "$API/api/threads" 2>/dev/null \
    | python3 -c "import sys,json; [print(t['id']) for t in json.load(sys.stdin).get('threads',[]) if t.get('firstRunQuestState') or t.get('bootcampState')]" 2>/dev/null \
    || true
}

echo "[dev-reset] Waiting for API on $API..."
for i in $(seq 1 $MAX_WAIT); do
  if curl -sf "$API/api/cats" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

for pass in $(seq 1 $MAX_RESET_PASSES); do
  CATS="$(list_cats)"
  THREADS="$(list_bootcamp_threads)"

  if [ -z "$CATS" ] && [ -z "$THREADS" ]; then
    echo "[dev-reset] Clean state confirmed on pass $pass."
    echo "[dev-reset] Done. Refresh the browser and re-enter the flow."
    exit 0
  fi

  if [ -n "$THREADS" ]; then
    while IFS= read -r tid; do
      [ -n "$tid" ] || continue
      curl -sf -X DELETE -H 'x-cat-cafe-user: default-user' "$API/api/threads/$tid" >/dev/null 2>&1 || true
      echo "[dev-reset] Deleted thread: $tid"
    done <<<"$THREADS"
  fi

  if [ -n "$CATS" ]; then
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      curl -sf -X DELETE -H 'x-cat-cafe-user: default-user' "$API/api/cats/$id" >/dev/null 2>&1 || true
      echo "[dev-reset] Deleted cat: $id"
    done <<<"$CATS"
  fi

  sleep 0.5
done

echo "[dev-reset] Failed to reach a clean state after $MAX_RESET_PASSES passes." >&2
echo "[dev-reset] Remaining cats: $(list_cats | tr '\n' ' ')" >&2
echo "[dev-reset] Remaining bootcamp threads: $(list_bootcamp_threads | tr '\n' ' ')" >&2
exit 1
