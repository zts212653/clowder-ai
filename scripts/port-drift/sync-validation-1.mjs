import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { it } from 'node:test';
import { ROOT, readFunctionBody, readSyncScript } from './context.mjs';

export function registerSyncValidationPart1() {
  it('validate mode runs the source-owned public gate on a temp target', () => {
    const content = readSyncScript();
    const staticGateFn = readFunctionBody(content, 'run_static_quality_gates');
    const validateBlock = content.match(
      /Validate temp target \(source-owned public gate\)[\s\S]*?\[VALIDATE\] Export at:/,
    )?.[0];

    assert.match(
      staticGateFn,
      /pnpm check:fix[\s\S]*pnpm check 2>&1[\s\S]*pnpm lint 2>&1/,
      'run_static_quality_gates should run pnpm check:fix → pnpm check → pnpm lint in order',
    );
    assert.ok(validateBlock, 'expected to find the validate block in sync-to-opensource.sh');
    assert.ok(
      validateBlock.includes('prepare_validation_target'),
      'validate mode should materialize a temp target before running the public gate',
    );
    assert.ok(
      validateBlock.includes('sync_filtered_into_target "$VALIDATION_TARGET_DIR"'),
      'validate mode should apply the exact exported payload to the temp target',
    );
    assert.ok(
      validateBlock.includes('run_target_public_gate "$VALIDATION_TARGET_DIR"'),
      'validate mode should reuse the same target/public gate as a real full sync',
    );
  });

  it('allows focused public diagnostics only in non-mutating validate mode', () => {
    const content = readSyncScript();
    assert.match(
      content,
      /CAT_CAFE_PUBLIC_TEST_FOCUS:-.*VALIDATE.*!= true[\s\S]*Real sync always requires the complete public test suite/,
      'focused public tests must fail closed outside --validate so a real sync cannot inherit a partial gate',
    );
  });

  it('full sync runs the temp target public gate before touching the real target', () => {
    const content = readSyncScript();
    const tempGateIndex = content.indexOf('Source-owned public gate (temp target)...');
    const realSyncIndex = content.indexOf('sync_filtered_into_target "$TARGET_DIR"');
    const step6SummaryIndex = content.indexOf('[Step 6/6] Sync committed after source-owned public gate passed');

    assert.notEqual(tempGateIndex, -1, 'expected to find the temp target public gate block');
    assert.notEqual(realSyncIndex, -1, 'expected to find the real target sync call');
    assert.ok(
      tempGateIndex < realSyncIndex,
      'the real target sync must happen only after the temp target public gate block',
    );
    assert.ok(step6SummaryIndex > realSyncIndex, 'the final summary should only run after the real target sync');
    assert.match(
      content,
      /run_target_public_gate "\$VALIDATION_TARGET_DIR"/,
      'full sync should reuse run_target_public_gate for the temp target check',
    );
  });

  it('temp target public gate appends the validation checkout to PROJECT_ALLOWED_ROOTS', () => {
    const gate = readFunctionBody(readSyncScript(), 'run_target_public_gate');
    assert.match(
      gate,
      /gate_target_real="\$\(resolve_physical_path "\$gate_target"\)"/,
      'run_target_public_gate should canonicalize the temp target root before exporting PROJECT_ALLOWED_ROOTS',
    );
    assert.match(
      gate,
      /PROJECT_ALLOWED_ROOTS_APPEND=true[\s\\]+PROJECT_ALLOWED_ROOTS="\$gate_target_real"[\s\\]+pnpm --filter @cat-cafe\/api run test:public:prepared/,
      'prepared public suite in the temp target should treat the validation checkout as an allowed project root',
    );
    assert.match(
      gate,
      /PROJECT_ALLOWED_ROOTS_APPEND=true[\s\\]+PROJECT_ALLOWED_ROOTS="\$gate_target_real"[\s\\]+API_SERVER_PORT=\$accept_api_port MEMORY_STORE=1 CAT_CAFE_INVOCATION_REGISTRY=memory NODE_ENV=test/,
      'API startup acceptance should reuse the same temp-target allow-root and explicitly select the degraded callback-auth backend used by this Redis-free local test',
    );
  });

  it('target public gate smokes F203 native L0 compiler closure', () => {
    const gate = readFunctionBody(readSyncScript(), 'run_target_public_gate');

    assert.match(
      gate,
      /node scripts\/compile-system-prompt-l0\.mjs --cat codex >\/dev\/null/,
      'target public gate should compile codex L0 so missing F203 script/template fails before real sync',
    );
  });

  it('temp target public gate installs dependencies without inherited production env', () => {
    const content = readSyncScript();
    const envHelper = readFunctionBody(content, 'run_public_acceptance_env');
    const gate = readFunctionBody(content, 'run_target_public_gate');

    assert.match(
      envHelper,
      /-u NODE_ENV/,
      'run_public_acceptance_env should clear inherited NODE_ENV so temp target installs do not skip devDependencies',
    );
    assert.match(
      envHelper,
      /-u npm_config_production/,
      'run_public_acceptance_env should clear npm_config_production for temp target public gate',
    );
    assert.match(
      envHelper,
      /-u NPM_CONFIG_PRODUCTION/,
      'run_public_acceptance_env should clear uppercase production npm config as well',
    );
    assert.match(
      gate,
      /run_public_acceptance_env pnpm install --frozen-lockfile/,
      'temp target install must use the sanitized env helper so public gate sees devDependencies',
    );
  });

  it('temp target public gate preserves full prepared-public-suite output before tailing', () => {
    const gate = readFunctionBody(readSyncScript(), 'run_target_public_gate');
    assert.match(
      gate,
      /test_public_log=\$\(mktemp "\$\{TMPDIR:-\/tmp\}\/cat-cafe-testpublic\.XXXXXX"\)/,
      'run_target_public_gate should capture prepared public suite output in a dedicated temp log',
    );
    assert.match(
      gate,
      /pnpm --filter @cat-cafe\/api run test:public:prepared >"\$test_public_log" 2>&1/,
      'prepared public suite should write its full output to a log file before summary tailing',
    );
    assert.match(
      gate,
      /tail -20 "\$test_public_log"/,
      'failure path should print a larger tail from the captured test:public log',
    );
    assert.doesNotMatch(
      gate,
      /pnpm --filter @cat-cafe\/api run test:public:prepared 2>&1 \| tail -5/,
      'prepared public suite should not pipe directly into tail, or failures become opaque',
    );
  });

  it('full sync exports from a detached origin/main source checkout or an explicit immutable pin', () => {
    const content = readSyncScript();
    assert.match(
      content,
      /prepare_source_sync_tree\(\) \{[\s\S]*git -C "\$SOURCE_DIR" fetch --no-tags origin main[\s\S]*local source_ref="refs\/remotes\/origin\/main"[\s\S]*git -C "\$SOURCE_DIR" worktree add --detach "\$SOURCE_SYNC_DIR" "\$source_ref"/m,
      'full sync should default to a detached origin/main checkout and materialize the resolved source ref',
    );
    assert.match(
      content,
      /if \[ -n "\$REQUESTED_SOURCE_SHA" \]; then[\s\S]*rev-parse --verify "\$\{REQUESTED_SOURCE_SHA\}\^\{commit\}"[\s\S]*merge-base --is-ancestor "\$resolved_source_sha" refs\/remotes\/origin\/main[\s\S]*source_ref="\$resolved_source_sha"/m,
      'an explicit source pin must resolve to a commit reachable from origin/main before export',
    );
    assert.match(
      content,
      /if \[ "\$PREFLIGHT" = false \] && \[ "\$DRY_RUN" = false \] && \[ "\$VALIDATE" = false \]; then[\s\S]*if \[ "\$SYNC_MODULE" = "all" \]; then[\s\S]*prepare_source_sync_tree/m,
      'real full sync should always switch the source baseline to a detached checkout',
    );
    assert.match(
      content,
      /if \{ \[ "\$PREFLIGHT" = true \] \|\| \[ "\$DRY_RUN" = true \] \|\| \[ "\$VALIDATE" = true \]; \} && \[ -n "\$REQUESTED_SOURCE_SHA" \]; then[\s\S]*prepare_source_sync_tree/m,
      'preflight, dry-run, and validate should use the same detached checkout when an immutable source pin is supplied',
    );
    assert.match(
      content,
      /MANIFEST="\$SOURCE_SYNC_DIR\/sync-manifest.yaml"/,
      'manifest parsing should follow the detached source checkout, not the caller worktree',
    );
    assert.match(
      content,
      /git -C "\$SOURCE_SYNC_DIR" archive 'HEAD\^\{tree\}' \| tar -x -C "\$STAGING_DIR"/,
      'step 1 export should archive the detached origin/main checkout for real full sync',
    );
    assert.match(
      content,
      /SOURCE_DISPLAY_SHA="\$\{SOURCE_SHA_SHORT\} \(origin\/main\)"/,
      'operator-facing provenance should make it explicit that full sync used origin/main',
    );
    assert.match(
      content,
      /prepare_source_sync_tree[\s\S]*?trap 'cleanup_source_sync_tree' EXIT/,
      'source sync worktree cleanup must be registered immediately after creation (P2: no leaked worktrees on early exit)',
    );
    assert.match(
      content,
      /exec bash "\$pinned_wrapper" "\$\{ORIGINAL_SYNC_ARGS\[@\]\}"/,
      'the first process must re-exec the wrapper committed in the detached source checkout',
    );
    assert.match(
      content,
      /actual_wrapper=\$\(resolve_physical_path "\$0"\)[\s\S]*expected_wrapper=\$\(resolve_physical_path "\$SOURCE_SYNC_DIR\/scripts\/sync-to-opensource\.sh"\)[\s\S]*"\$actual_wrapper" != "\$expected_wrapper"/,
      'the child must fail closed unless the executing wrapper itself comes from SOURCE_SYNC_DIR',
    );
    assert.match(
      content,
      /node "\$SOURCE_SYNC_DIR\/scripts\/export-public-feature-docs\.mjs"/,
      'feature-doc exporter must run from SOURCE_SYNC_DIR, not SOURCE_DIR (P1: no mixed provenance)',
    );
    assert.match(
      content,
      /SANITIZER="\$SOURCE_SYNC_DIR\/scripts\/_sanitize-rules\.pl"/,
      'sanitizer rules must load from SOURCE_SYNC_DIR, not SOURCE_DIR (P1: no mixed provenance)',
    );
    // The canonical public site keeps its deliberate "Clowder AI" origin story, but that exemption
    // is scoped to the product name inside _sanitize-rules.pl. Pruning the whole tree here also
    // disabled identity, home-path, and port scrubbing for the website, and the security scan
    // did not cover .html/.mjs/.css either — so a /home/user path exported with a clean scan.
    assert.doesNotMatch(
      content,
      /-path "\$FILTERED_DIR\/site" -prune/,
      'the public site brand exemption belongs in _sanitize-rules.pl, not a whole-tree sanitizer bypass',
    );
    const sanitizerRules = readFileSync(resolve(ROOT, 'scripts/_sanitize-rules.pl'), 'utf8');
    assert.match(
      sanitizerRules,
      /\$is_public_site = index\(\$ARGV, "\$sanitize_root\/site\/"\) == 0/,
      'the site exemption must be anchored to the declared export root, not any nested site/ segment',
    );
    assert.match(
      content,
      /if \[ "\$phase_label" = "final" \] && is_transform_target "\$excl"; then/,
      'final exclusions must preserve files generated by declared manifest transforms',
    );
    assert.match(
      content,
      /assert_export_exclusions_absent "final"/,
      'the final-tree invariant must distinguish transform targets from private source files',
    );
    assert.match(
      content,
      /node "\$SOURCE_SYNC_DIR\/scripts\/check-sync-public-delta-reconciliation-cli\.mjs"/,
      'reconciliation decisions must run from the frozen source checkout',
    );
    assert.match(
      content,
      /"\$SOURCE_SYNC_DIR\/scripts\/append-sync-provenance-telemetry\.mjs"/,
      'provenance telemetry must run from the frozen source checkout',
    );
  });
}
