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

# F279: tests that start the API must not inherit production listen-state or
# audio-cache paths. HOME already points at the per-run test sandbox.
unset CAT_CAFE_DATA_DIR
unset TTS_CACHE_DIR
unset LISTEN_MODE_DB
# Runtime-only envs leak from invocation env (set by the running cat-cafe-runtime
# process when launching a cat). resolveBinaryRoot()/orchestrator code treats
# CAT_CAFE_RUNTIME_ROOT as the highest-priority binary root override, which makes
# capabilities/MCP-path tests assert against `cat-cafe-runtime/...` instead of the
# stable main repo root. Strip them so test runs see the same environment whether
# launched from a runtime invocation or a clean shell.
unset CAT_CAFE_RUNTIME_ROOT
unset CAT_CAFE_MCP_SERVER_PATH
unset CAT_CAFE_WORKSPACE_ROOT

# Runtime shells may select persistent transports for live agent invocations.
# Tests rely on each provider's default carrier so spawn seams remain the only
# process boundary; inheriting these overrides could launch a real provider CLI.
unset CAT_CAFE_CODEX_CARRIER
unset CAT_CAFE_CLAUDE_CARRIER

# API_SERVER_HOST is a runtime binding choice. LAN/dev invocations commonly set
# it to 0.0.0.0, but capability write tests expect localhost-only defaults unless
# an individual test explicitly sets the host under test.
unset API_SERVER_HOST

# DEFAULT_CAT_ID is user/runtime preference, not test fixture state. Leaving it
# inherited makes routing tests depend on which cat launched the test command.
unset DEFAULT_CAT_ID

exec "$@"
