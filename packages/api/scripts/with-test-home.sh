#!/usr/bin/env bash
set -euo pipefail

real_home="${HOME:-}"
tmp_parent="${TMPDIR:-/tmp}"
tmp_parent="${tmp_parent%/}"
raw_test_home="$(mktemp -d "${tmp_parent}/cat-cafe-test-home-XXXXXX")"
test_home="$(cd "$raw_test_home" && pwd -P)"

cleanup() {
  rm -rf "$raw_test_home"
}

trap cleanup EXIT

export HOME="$test_home"
export CAT_CAFE_TEST_SANDBOX="${CAT_CAFE_TEST_SANDBOX:-1}"
export CAT_CAFE_TEST_REAL_HOME="${CAT_CAFE_TEST_REAL_HOME:-$real_home}"
# Test entrypoints must not inherit a production NODE_ENV from the outer shell.
# Telemetry redaction tests rely on test-mode defaults instead of production secrets.
export NODE_ENV="test"

exec "$@"
