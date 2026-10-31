import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFunctionBody, readSyncScript } from './context.mjs';

export function registerSyncSafetyPart1() {
  it('resolves TARGET_DIR through a physical-path helper before safety checks', () => {
    const content = readSyncScript();
    const membershipGuard = readFunctionBody(content, 'source_worktree_realpath_registered');
    assert.match(
      content,
      /resolve_physical_path\(\) \{[\s\S]*os\.path\.realpath\(sys\.argv\[1\]\)/,
      'sync script should resolve TARGET_DIR through a realpath helper so symlink aliases cannot bypass the guard',
    );
    assert.match(
      content,
      /RESOLVED_TARGET="\$\(resolve_physical_path "\$TARGET_DIR"\)"/,
      'sync script should guard on the resolved physical TARGET_DIR path',
    );
    assert.match(
      content,
      /source_worktree_realpath_registered "\$RESOLVED_TARGET"/,
      'sync script should compare TARGET_DIR against source worktrees using resolved realpaths',
    );
    assert.match(
      membershipGuard,
      /while IFS= read -r candidate_path; do[\s\S]*found=true[\s\S]*done < <\(list_source_worktree_realpaths\)[\s\S]*\[ "\$found" = true \]/m,
      'worktree membership must consume the complete realpath stream before returning match status',
    );
    assert.doesNotMatch(
      content,
      /list_source_worktree_realpaths\s*\|\s*grep\s+-q/,
      'grep -q closes the realpath pipeline early and becomes a false negative under pipefail',
    );
  });

  it('recognizes git worktrees as valid target repos', () => {
    const content = readSyncScript();
    assert.match(
      content,
      /target_git_repo_exists\(\) \{\s+local repo_dir="\$1"\s+git -C "\$repo_dir" rev-parse --git-dir >/m,
      'sync script should detect target repos via git rev-parse so linked worktrees are accepted',
    );
    assert.match(
      content,
      /if ! target_git_repo_exists "\$TARGET_DIR"; then[\s\S]*Target git repo not found/m,
      'prepare_validation_target should use the git repo helper before rejecting the target',
    );
    assert.match(
      content,
      /if \[ "\$PREFLIGHT" = false \] && \[ "\$DRY_RUN" = false \] && \[ "\$VALIDATE" = false \] && target_git_repo_exists "\$TARGET_DIR"; then/m,
      'real sync target gates should treat linked worktrees as valid repos',
    );
    assert.match(
      content,
      /if target_git_repo_exists "\$TARGET_DIR"; then\s+cd "\$TARGET_DIR"\s+git add -A/m,
      'auto-commit finalization should also run for linked worktree targets',
    );
  });

  it('startup acceptance ports do not inherit runtime shell env', () => {
    const content = readSyncScript();
    assert.doesNotMatch(
      content,
      /ACCEPT_API_PORT=\$\{API_SERVER_PORT:-3004\}|accept_api_port=\$\{API_SERVER_PORT:-3004\}/,
      'startup acceptance must not inherit API_SERVER_PORT from the parent shell',
    );
    assert.doesNotMatch(
      content,
      /ACCEPT_WEB_PORT=\$\{FRONTEND_PORT:-3003\}|accept_web_port=\$\{FRONTEND_PORT:-3003\}/,
      'startup acceptance must not inherit FRONTEND_PORT from the parent shell',
    );
    assert.match(
      content,
      /accept_api_port="\$\(find_available_port 3004\)"/,
      'startup acceptance should choose its API port from a script-owned helper',
    );
    assert.match(
      content,
      /accept_web_port="\$\(find_available_port 3003 "\$accept_api_port"\)"/,
      'startup acceptance should choose a distinct frontend port from a script-owned helper',
    );
  });

  it('startup acceptance does not treat the public Preview Gateway port as forbidden leakage', () => {
    const gate = readFunctionBody(readSyncScript(), 'run_target_public_gate');
    assert.match(
      gate,
      /forbidden_ports="3001\|3002\|3011\|3012\|4111\|4000\|6397\|6398\|6399"/,
      'startup acceptance should only block internal/runtime ports, not the public Preview Gateway default',
    );
    assert.doesNotMatch(
      gate,
      /forbidden_ports=.*4100/,
      'startup acceptance must not reject the exported Preview Gateway default port 4100',
    );
  });

  it('startup acceptance forces watchpack polling for frontend dev server', () => {
    const gate = readFunctionBody(readSyncScript(), 'run_target_public_gate');
    assert.match(
      gate,
      /run_public_startup_env "\$startup_state" "\$gate_target_real" WATCHPACK_POLLING=true PORT=\$accept_web_port\s+\\\s+pnpm --filter @cat-cafe\/web dev -p \$accept_web_port/,
      'startup acceptance should avoid native watchpack EMFILE failures on release machines with many worktrees',
    );
  });

  it('startup acceptance bounds readiness probes by wall-clock deadlines', () => {
    const content = readSyncScript();
    const gate = readFunctionBody(content, 'run_target_public_gate');
    const remainingHelper = readFunctionBody(content, 'remaining_wall_clock_seconds');
    const timeoutHelper = readFunctionBody(content, 'curl_probe_timeout');

    assert.match(
      remainingHelper,
      /remaining=\$\(\( deadline - now \)\)/,
      'remaining_wall_clock_seconds should calculate time left from an absolute deadline',
    );
    assert.match(
      timeoutHelper,
      /if \[ "\$remaining" -lt "\$max_timeout" \]; then/,
      'curl_probe_timeout should cap each probe by the remaining wall-clock budget',
    );
    assert.match(
      gate,
      /web_deadline=\$\(\( \$\(date \+%s\) \+ web_wait_seconds \)\)/,
      'frontend readiness should use an absolute deadline derived from PUBLIC_GATE_FRONTEND_WAIT_SECONDS',
    );
    assert.match(
      gate,
      /remaining="\$\(remaining_wall_clock_seconds "\$web_deadline"\)"/,
      'frontend readiness should recompute remaining wall-clock time on each probe',
    );
    assert.match(
      gate,
      /curl_timeout="\$\(curl_probe_timeout "\$remaining" 5\)"/,
      'frontend readiness should cap each curl probe instead of multiplying a long timeout by loop count',
    );
    assert.doesNotMatch(
      gate,
      /for i in \$\(seq 1 "\$web_wait_seconds"\)[\s\S]*curl -sf --max-time 30/,
      'frontend readiness must not multiply a 30s curl timeout by the advertised wait seconds',
    );
  });
}
