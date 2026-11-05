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
export CAT_CAFE_TEST_SANDBOX="1"
export CAT_CAFE_TEST_REAL_HOME="${CAT_CAFE_TEST_REAL_HOME:-$real_home}"
# Isolation starts here; a live shell's config root or opt-out must not survive.
# Tests exercising overrides can set them explicitly inside the sandbox.
unset CAT_CAFE_GLOBAL_CONFIG_ROOT
unset CAT_CAFE_CONFIG_ROOT
unset CAT_TEMPLATE_PATH
unset CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT
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

# Managed-command authority belongs to the outer gate supervisor. Test children
# must not inherit it: suites that exercise hold_ball/managed jobs need to create
# their own fixture authority, and an inherited job id makes every launch look
# like a forbidden nested managed command.
for managed_env in ${!CAT_CAFE_MANAGED_@}; do
  unset "$managed_env"
done

# Bash exports functions as BASH_FUNC_<name>%% environment entries. The outer
# gate uses exported helpers, but test children must not inherit those shell
# control functions as invocation environment. Remove only functions carrying
# Bash's export attribute; local helpers such as cleanup remain available.
while IFS= read -r exported_function; do
  if [[ "$exported_function" == "declare -fx "* ]]; then
    inherited_function="${exported_function#declare -fx }"
    export -n -f "$inherited_function"
    unset -f "$inherited_function"
  fi
done < <(export -p -f)

# A runtime-selected Codex login/state home overrides HOME. Keep native reads
# inside the sandbox; individual tests may select their own fixture afterward.
unset CODEX_HOME
unset CODEX_SQLITE_HOME

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

# Fixtures own private managed jobs and pools; the outer runner retains its real
# permit and cleanup tokens. Runtime/provider identity is not test fixture state.
unset CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD
unset CAT_CAFE_FULL_GATE_RESOURCE_MODE
unset CAT_CAFE_FULL_GATE_RESOURCE_PRIORITY
unset CAT_CAFE_FULL_GATE_RESOURCE_STAGE
unset CAT_CAFE_FULL_GATE_RESOURCE_CLASS
unset CAT_CAFE_FULL_GATE_RESOURCE_CLAIMS
unset CAT_CAFE_MANAGED_JOB_ID
unset CAT_CAFE_MANAGED_JOB_RECORD_PATH
unset CAT_CAFE_MANAGED_CANCEL_REQUEST_PATH
unset CAT_CAFE_MANAGED_TERMINAL_STATE
unset CAT_CAFE_MANAGED_GATE_RECOVERY_PROTOCOL
unset CAT_CAFE_MANAGED_GATE_ATTEMPT_TOKEN
unset CAT_CAFE_MANAGED_GATE_FROZEN_IDENTITY_JSON
unset CAT_CAFE_MANAGED_GATE_RECOVERY_READY_PATH
unset CAT_CAFE_MANAGED_GATE_RESUME_EPOCH
unset CAT_CAFE_MANAGED_GATE_RECONCILE_FROM
unset CAT_CAFE_ALPHA_RECOVERY_JOURNAL
unset CAT_CAFE_ALPHA_OBSERVER_UNIT_KEY
unset CAT_CAFE_GATE_ORIGIN_TASK_ID
unset CAT_CAFE_GATE_EXECUTION_OWNER_JOB_ID
unset CAT_CAFE_GATE_EXECUTION_PARENT_JOB_ID
unset CAT_CAFE_GATE_EXECUTION_ORIGIN_TASK_ID
unset CAT_CAFE_GATE_EXECUTION_RESUME_KIND
unset CAT_CAFE_GATE_EXECUTION_RESUME_KEY
unset CAT_CAFE_GATE_EXECUTION_RESUME_SOURCE_RUN_ID
unset CAT_CAFE_GATE_EXECUTION_SLA_MS
unset ANTHROPIC_API_KEY
unset OPENAI_API_KEY
unset GOOGLE_API_KEY
unset GEMINI_API_KEY
unset MOONSHOT_API_KEY

# REDIS_URL is a runtime binding like the variables above, but unsetting it is
# not enough: an absent URL can select a shared default endpoint. Nor is 6398
# proof of an owned test store: another checkout may be using it. Non-Redis
# suites must have a non-connectable binding, and discard inherited data paths.
#
# The isolated runner can call pnpm test, which enters this wrapper again.
# Preserve that runner's endpoint/DB only after checking its existing lease,
# manifest and live process ownership. A flag alone cannot authorize a URL.
#
# Shard children are narrowed further by PUBLIC_TEST_DENY_REDIS_URL in
# packages/api/scripts/public-test-isolation-preflight.mjs, which rewrites them
# to a non-connectable endpoint. This pin is the floor, that rewrite is the
# stricter case; they are not duplicates of each other.
if [[ "${CAT_CAFE_REDIS_TEST_ISOLATED:-}" == "1" ]]; then
  test_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  # The validator must run before a test preload can rewrite the candidate DB.
  REDIS_URL="$(NODE_OPTIONS= NODE_TEST_CONTEXT= node "$test_script_dir/redis-test-entrypoint.mjs")"
  export REDIS_URL
else
  unset REDIS_PORT REDIS_DATA_DIR REDIS_BACKUP_DIR REDIS_KEY_PREFIX
  export REDIS_URL="redis://127.0.0.1:0"
fi

exec "$@"
