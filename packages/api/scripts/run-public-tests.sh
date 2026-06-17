#!/usr/bin/env bash
# Run the public test suite under the test-home environment.
#
# Fail-propagates resolver errors (TTL expired, stale entry, malformed registry)
# instead of silently falling back to Node's full test discovery. Without this
# wrapper, a `$(node ./scripts/resolve-public-test-files.mjs)` substitution
# inside the npm script would discard the resolver's exit code and let
# `node --test` run with no file arguments — which makes Node walk the whole
# tree and masks governance failures (codex review #2326 P1, 2026-06-16).
set -euo pipefail

cd "$(dirname "$0")/.."

if ! files=$(node ./scripts/resolve-public-test-files.mjs); then
  echo "test:public resolver exited non-zero — refusing to run tests with an undefined file set" >&2
  exit 1
fi

if [[ -z "${files}" ]]; then
  echo "test:public resolver returned an empty file set — refusing to run tests (would default to full-tree discovery)" >&2
  exit 1
fi

# shellcheck disable=SC2086 # $files is intentionally word-split into argv
exec node \
  --import "$(pwd)/test/helpers/setup-cat-registry.js" \
  --test \
  --test-concurrency=1 \
  $files
