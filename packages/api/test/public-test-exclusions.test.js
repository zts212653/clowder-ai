import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const registryPath = resolve(packageRoot, 'config/public-test-exclusions.json');
const resolverModuleUrl = pathToFileURL(resolve(packageRoot, 'scripts/resolve-public-test-files.mjs')).href;

const RECONCILED_EXCLUSIONS = [
  '^(?:test/approval\\-hub/approval\\-publication\\-redis\\-contract\\.test\\.js|test/approval\\-hub/redis\\-dispatch\\-proposal\\-store\\.test\\.js|test/approval\\-hub/redis\\-entity\\-proposal\\-dedup\\.test\\.js|test/dossier\\-distillation\\-redis\\-store\\.test\\.js|test/dossier\\-observation\\-redis\\-store\\.test\\.js|test/f254\\-freshness\\-closure\\-redis\\-store\\.test\\.js|test/f254\\-freshness\\-supplement\\-redis\\-store\\.test\\.js|test/f254\\-output\\-commit\\-redis\\-race\\.test\\.js|test/issue1371\\-redis\\-convergence\\.test\\.js|test/person\\-memory\\-redis\\-store\\.test\\.js|test/plugin\\-messaging\\-redis\\-event\\-fencing\\.test\\.js|test/plugin\\-messaging\\-redis\\-snapshot\\.test\\.js|test/plugin\\-messaging\\-redis\\-stores\\.test\\.js|test/redis\\-action\\-successor\\-lease\\-store\\.test\\.js|test/redis\\-action\\-successor\\-task\\-lifecycle\\.test\\.js|test/redis\\-backlog\\-store\\.test\\.js|test/redis\\-community\\-bootstrap\\.test\\.js|test/redis\\-community\\-event\\-log\\.test\\.js|test/redis\\-community\\-pr\\-lifecycle\\.test\\.js|test/redis\\-community\\-projector\\.test\\.js|test/redis\\-concierge\\-config\\-store\\.test\\.js|test/redis\\-connector\\-binding\\-store\\.test\\.js|test/redis\\-f168\\-phase\\-b\\-awaiting\\-external\\.test\\.js|test/redis\\-grounding\\-sample\\-store\\.test\\.js|test/redis\\-invocation\\-record\\-store\\.test\\.js|test/redis\\-label\\-store\\.test\\.js|test/redis\\-limb\\-pairing\\-persistence\\.test\\.js|test/redis\\-message\\-delivery\\-atomicity\\.test\\.js|test/redis\\-message\\-delivery\\-contracts\\.test\\.js|test/redis\\-message\\-store\\.test\\.js|test/redis\\-pr\\-tracking\\-store\\.test\\.js|test/redis\\-profile\\-update\\-proposal\\-store\\.test\\.js|test/redis\\-proposal\\-store\\-finalize\\.test\\.js|test/redis\\-proposal\\-withdraw\\.test\\.js|test/redis\\-read\\-state\\-store\\.test\\.js|test/redis\\-repo\\-comment\\-cursor\\.test\\.js|test/redis\\-runtime\\-interaction\\-store\\.test\\.js|test/redis\\-runtime\\-session\\-store\\.test\\.js|test/redis\\-session\\-chain\\-store\\.test\\.js|test/redis\\-session\\-handoff\\-disposition\\.test\\.js|test/redis\\-session\\-handoff\\-proposal\\-store\\.test\\.js|test/redis\\-summary\\-store\\.test\\.js|test/redis\\-task\\-progress\\-store\\.test\\.js|test/redis\\-task\\-store\\.test\\.js|test/redis\\-taste\\-proposal\\-recovery\\.test\\.js|test/redis\\-test\\-db\\-namespace\\.test\\.js|test/redis\\-thread\\-store\\.test\\.js|test/redis\\-tip\\-telemetry\\-sink\\.test\\.js|test/redis\\-turn\\-execution\\-store\\.test\\.js|test/redis\\-unread\\-summary\\-visibility\\-cursor\\.test\\.js|test/signal\\-intake/redis\\-signal\\-intake\\.test\\.js|test/stores/redis\\-frustration\\-issue\\-store\\-window\\.test\\.js)$',
  '^test/redis-restore-script\\.test\\.js$',
  'workflow-sop-store',
  '^(?:test/memory/cat\\-cafe\\-scanner\\-recall\\.test\\.js|test/memory/entity\\-seeds\\.test\\.js|test/memory/f209\\-recall\\-fixtures\\.test\\.js|test/memory/f287\\-billing\\-only\\-journey\\.test\\.js|test/memory/taste\\-index\\-authority\\.test\\.js)$',
  '^(?:test/memory/asr\\-defer\\-receipt\\-lineage\\.test\\.js|test/memory/asr\\-write\\-opportunity\\-delivery\\-store\\.test\\.js|test/memory/asr\\-write\\-opportunity\\-terminal\\-ledger\\.test\\.js)$',
  'shared-state-wiring\\.test',
  'write-vignette-publication-hook\\.test',
  'capability-evolution-evaluation-owner-join\\.test',
  'capability-evolution-microduck-football-private-archive\\.test\\.js$',
  '(?:capability-evolution-e0-owner-inputs|f314-capability-evolution-owner-inputs|harness-eval/(?:capability-evolution-measurement-(?:issuer(?:-security)?|source-store)|f311-(?:capability-evolution-wakeup|e0-eval-repair-owner-provider)))\\.test',
  '^test/capability-evolution-exploration-(?:archive-projection|football|integrity|record-failures)\\.test\\.js$',
  'signal-fetcher-launchd',
  'reflection-capsule-m3',
  'pack-integration\\.test',
  'root-md-slim\\.test',
  'audit-cc-system-prompt\\.test',
  'f188-cold-start-fixtures\\.test',
  'f188-harness-consistency\\.test',
  'f236-cc-anchor-hook\\.test',
  'harness-eval/eval-hub-read-model\\.test',
  'harness-eval/merge-gate-provenance-contract\\.test',
  'harness-eval/design-gate-episode-source-provider-private-evidence\\.test',
  '^(?:test/f254\\-freshness\\-instruction\\-private\\-evidence\\.test\\.js|test/f254\\-manual\\-reminder\\-scope\\.test\\.js)$',
  '^(?:test/harness\\-eval/eval\\-hub\\-lifecycle\\-summary\\-route\\.test\\.js|test/harness\\-eval/eval\\-hub\\-read\\-model\\-f248\\-phase\\-b2\\.test\\.js|test/harness\\-eval/eval\\-hub\\-route\\.test\\.js)$',
  'harness-eval/(?:friction-measurement-bundle|measurement-independent-rejudge(?:-adjudication|-judgment)?)\\.test',
  'harness-eval/measurement-decision-proof(?:-resolver)?\\.test',
  'harness-eval/publish-verdict-(?:capability-wakeup(?:-owner-scope)?|freshness|friction|measurement-validity-gate|memory|pipeline|task-outcome(?:-writeback-guard)?)\\.test',
  'harness-eval/legacy-reeval-case-(?:hub|migration)\\.test',
];

async function listTestFiles(rootDir, relDir = '') {
  const dir = resolve(rootDir, relDir);
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relPath = relDir ? posix.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listTestFiles(rootDir, relPath)));
      continue;
    }
    if (entry.isFile() && relPath.endsWith('.test.js')) {
      files.push(posix.join('test', relPath));
    }
  }
  return files.sort();
}

function applyReconciledSelection(files) {
  const patterns = RECONCILED_EXCLUSIONS.map((value) => new RegExp(value));
  return files.filter((file) => patterns.every((pattern) => !pattern.test(file))).sort();
}

test('registry retains only audited exclusions and drops re-admitted cases', async () => {
  const { loadPublicTestExclusions } = await import(resolverModuleUrl);
  const registry = await loadPublicTestExclusions({ configPath: registryPath });

  assert.equal(registry.version, 2);
  assert.equal(registry.entries.length, RECONCILED_EXCLUSIONS.length);
  for (const entry of registry.entries) {
    assert.match(entry.audit.sourceHead, /^[a-f0-9]{40}$/);
    assert.match(entry.audit.publicHead, /^[a-f0-9]{40}$/);
    assert.match(entry.audit.reviewedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(entry.audit.matchedFilesHash, /^[a-f0-9]{64}$/);
    assert.ok(entry.audit.matchedFileCount > 0);
  }
  for (const id of [
    'task-progress-store',
    'signal-article-store',
    'cursor-store-atomicity',
    'claude-settings-hooks',
    'game-store',
    'cross-cat-context',
    'workspace-project-context',
    'projects-setup',
    'projects-mkdir',
    'governance-status',
    'project-setup-flow',
    'expedition-bootstrap',
    'rules-route',
    'orphan-chrome-cleaner',
    'f203-phase-i-opencode-l0',
    'github-schedule-factories',
  ]) {
    assert.equal(
      registry.entries.some((entry) => entry.id === id),
      false,
      `${id} must be re-admitted`,
    );
  }
  assert.equal(
    registry.entries.some((entry) => entry.match === 'antigravity-cdp-client\\.test'),
    false,
  );
  assert.equal(
    registry.entries.some((entry) => entry.match === 'capabilities-route\\.test'),
    false,
  );
  assert.equal(
    registry.entries.some((entry) => entry.match === 'governance-pack\\.test'),
    false,
    'retired managed-block tests must not leave a stale public exclusion',
  );
});

test('resolver preserves the reconciled public test file selection', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const allTestFiles = await listTestFiles(resolve(packageRoot, 'test'));
  const expected = applyReconciledSelection(allTestFiles);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  assert.deepEqual(resolved.selectedFiles, expected);
});

test('resolver excludes source-only cc anchor hook coverage from the public gate', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  assert.ok(resolved.excludedFiles.includes('test/f236-cc-anchor-hook.test.js'));
  assert.ok(!resolved.selectedFiles.includes('test/f236-cc-anchor-hook.test.js'));
});

test('resource-only SOP coverage stays excluded while portable Codex contracts are re-admitted', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  const workflowEntry = resolved.registry.entries.find((entry) => entry.id === 'workflow-sop-store');

  assert.ok(workflowEntry, 'workflow SOP resource contract must retain an audited exclusion');
  assert.equal(workflowEntry.audit.status, 'resource_contract');
  assert.equal(workflowEntry.publicAudit?.status, 'resource_contract');
  assert.equal(
    workflowEntry.expiresOn,
    '2027-12-31',
    'the stable isolated-Redis resource contract must not require rolling short renewals',
  );
  assert.ok(resolved.excludedFiles.includes('test/workflow-sop-store.test.js'));
  assert.ok(!resolved.selectedFiles.includes('test/workflow-sop-store.test.js'));

  for (const portableContract of ['test/codex-agent-service.test.js', 'test/codex-agent-service-l0.test.js']) {
    assert.ok(resolved.selectedFiles.includes(portableContract), `${portableContract} must stay re-admitted`);
    assert.ok(!resolved.excludedFiles.includes(portableContract), `${portableContract} must not be source-only`);
  }
});

test('memory exclusion audit binds the current source-managed candidate', async () => {
  const { loadPublicTestExclusions } = await import(resolverModuleUrl);
  const registry = await loadPublicTestExclusions({ configPath: registryPath });
  const memoryEntry = registry.entries.find((entry) => entry.id === 'memory-tests');

  assert.ok(memoryEntry, 'memory exclusion must remain audited');
  assert.equal(memoryEntry.audit.sourceHead, '9663e789484fbf7569f1159c9779f1c9ab89375e');
  assert.equal(memoryEntry.audit.publicHead, 'b1fe2966fa0a97d1e3cd2e174ed59fd1477b4fc4');
  assert.equal(memoryEntry.audit.matchedFileCount, 5);
  assert.equal(memoryEntry.publicAudit, undefined, 'the stale public-main snapshot is not an exported-candidate audit');
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const selection = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  assert.ok(selection.selectedFiles.includes('test/memory-cue-invocation-read.test.js'));
  assert.ok(!selection.excludedFiles.includes('test/memory-cue-invocation-read.test.js'));
});

test('resolver re-admits the exported Claude hooks and F296 composition coverage', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  for (const portableTest of [
    'test/f296-b3b3-post-compact-hook.test.js',
    'test/f296-session-hook-source-auth.test.js',
  ]) {
    assert.ok(resolved.selectedFiles.includes(portableTest));
  }
  assert.ok(resolved.selectedFiles.includes('test/f296-session-hook-auth.test.js'));
  assert.ok(resolved.selectedFiles.includes('test/f296-b3b3-provider-boundary-integration.test.js'));
});

test('resolver excludes the home-only tracked post-checkout hook contract from the public gate', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  const sourceOnlyTest = 'test/write-vignette-publication-hook.test.js';
  assert.ok(resolved.excludedFiles.includes(sourceOnlyTest));
  assert.ok(!resolved.selectedFiles.includes(sourceOnlyTest));
});

test('resolver excludes F311 owner-join coverage that reads source-only F267 measurement proofs', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  const sourceOnlyTest = 'test/capability-evolution-evaluation-owner-join.test.js';
  assert.ok(resolved.excludedFiles.includes(sourceOnlyTest));
  assert.ok(!resolved.selectedFiles.includes(sourceOnlyTest));
});

test('resolver excludes capability-evolution integrations backed by home-only owner evidence', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  for (const sourceOnlyTest of [
    'test/capability-evolution-e0-owner-inputs.test.js',
    'test/capability-evolution-microduck-football-private-archive.test.js',
    'test/f314-capability-evolution-owner-inputs.test.js',
    'test/harness-eval/capability-evolution-measurement-issuer-security.test.js',
    'test/harness-eval/capability-evolution-measurement-issuer.test.js',
    'test/harness-eval/capability-evolution-measurement-source-store.test.js',
    'test/harness-eval/f311-capability-evolution-wakeup.test.js',
    'test/harness-eval/f311-e0-eval-repair-owner-provider.test.js',
  ]) {
    assert.ok(resolved.excludedFiles.includes(sourceOnlyTest), `${sourceOnlyTest} should be private-fixture-only`);
    assert.ok(!resolved.selectedFiles.includes(sourceOnlyTest));
  }
});

test('resolver excludes private evidence consumers but keeps self-contained public contracts', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  for (const file of [
    'test/f254-freshness-instruction-private-evidence.test.js',
    'test/harness-eval/design-gate-episode-source-provider-private-evidence.test.js',
    'test/harness-eval/measurement-decision-proof-resolver.test.js',
    'test/harness-eval/measurement-decision-proof.test.js',
    'test/harness-eval/publish-verdict-memory.test.js',
  ]) {
    assert.ok(resolved.excludedFiles.includes(file), `${file} should be private-fixture-only`);
  }
  for (const file of [
    'test/f254-freshness-replay-provider.test.js',
    'test/f254-provider-native-freshness.test.js',
    'test/cicd-router.test.js',
    'test/embed-runtime-policy.test.js',
    'test/f254-freshness-instruction-surface.test.js',
    'test/harness-eval/design-gate-episode-source-provider.test.js',
    'test/harness-eval/eval-capability-tips-enable-gate.test.js',
    'test/harness-eval/measurement-bundle-census.test.js',
    'test/system-prompt-builder.test.js',
    'test/weixin-mp-path-security.test.js',
  ]) {
    assert.ok(resolved.selectedFiles.includes(file), `${file} should remain a public behavior contract`);
  }
});

test('focused public selection accepts only explicit files from the live selected suite', async () => {
  const { buildPublicTestManifest, resolvePublicTestFiles, selectFocusedPublicTestFiles } = await import(
    resolverModuleUrl
  );
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  assert.deepEqual(
    selectFocusedPublicTestFiles(
      resolved,
      'test/cicd-router.test.js,test/harness-eval/eval-capability-tips-enable-gate.test.js',
    ),
    ['test/cicd-router.test.js', 'test/harness-eval/eval-capability-tips-enable-gate.test.js'],
  );
  assert.throws(
    () => selectFocusedPublicTestFiles(resolved, 'test/harness-eval/publish-verdict-memory.test.js'),
    /excluded by registry/,
  );
  assert.throws(() => selectFocusedPublicTestFiles(resolved, 'test/not-real.test.js'), /does not exist/);
  assert.throws(
    () => selectFocusedPublicTestFiles(resolved, 'test/cicd-router.test.js,test/cicd-router.test.js'),
    /duplicate/,
  );

  const fullManifest = buildPublicTestManifest(resolved);
  const focusedManifest = buildPublicTestManifest(
    resolved,
    selectFocusedPublicTestFiles(resolved, 'test/cicd-router.test.js,test/system-prompt-builder.test.js'),
  );
  assert.match(fullManifest.selectionHash, /^[a-f0-9]{64}$/);
  assert.match(fullManifest.exclusionRegistryHash, /^[a-f0-9]{64}$/);
  assert.notEqual(fullManifest.selectionHash, focusedManifest.selectionHash);
  assert.deepEqual(fullManifest.selectedFiles, [...resolved.selectedFiles].sort());
});

test('resolver re-admits capabilities-route once the product regression is fixed', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  assert.ok(!resolved.excludedFiles.includes('test/capabilities-route.test.js'));
  assert.ok(resolved.selectedFiles.includes('test/capabilities-route.test.js'));
});

test('default expiry date helper uses the configured policy timezone rather than UTC', async () => {
  const { formatLocalIsoDate } = await import(resolverModuleUrl);
  const utcAfterPacificMidnight = new Date('2026-07-01T01:30:00.000Z');
  assert.equal(formatLocalIsoDate(utcAfterPacificMidnight, 'America/Los_Angeles'), '2026-06-30');
  assert.equal(formatLocalIsoDate(utcAfterPacificMidnight, 'UTC'), '2026-07-01');
});

test('default expiry date helper falls back to the repo policy timezone when env is unset', async () => {
  const { formatLocalIsoDate } = await import(resolverModuleUrl);
  const utcAfterPacificMidnight = new Date('2026-07-01T01:30:00.000Z');
  const previousPolicyTimezone = process.env.CAT_CAFE_POLICY_TIMEZONE;
  const previousHostTimezone = process.env.TZ;
  delete process.env.CAT_CAFE_POLICY_TIMEZONE;
  process.env.TZ = 'UTC';
  try {
    assert.equal(formatLocalIsoDate(utcAfterPacificMidnight), '2026-06-30');
  } finally {
    if (previousPolicyTimezone === undefined) delete process.env.CAT_CAFE_POLICY_TIMEZONE;
    else process.env.CAT_CAFE_POLICY_TIMEZONE = previousPolicyTimezone;
    if (previousHostTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousHostTimezone;
  }
});

/**
 * The `redis-` exclusion is a *filename prefix* standing in for a resource
 * dependency, and a prefix cannot tell the two apart. `redis-thread-list-batch`
 * built its own Map and a plain object literal for `redis`, constructed
 * `RedisThreadStore` on top, and never created a client or opened a connection
 * -- but it matched the prefix, so re-signing the audit for it would have moved
 * 21 ordinary product regressions out of the public suite under a reason
 * ("public CI resource availability") that was never true of them.
 *
 * Mock-only store tests stay public; audit dependencies instead of re-signing a prefix.
 */
test('a mock-only store test stays in the public selection regardless of what it imports', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  assert.ok(
    resolved.selectedFiles.includes('test/thread-list-batch.test.js'),
    'the mock-only batch test must run in the public suite',
  );
  assert.ok(
    !resolved.excludedFiles.includes('test/thread-list-batch.test.js'),
    'no exclusion may claim a test that needs no excluded resource',
  );
});

test('portable synthetic memory regressions stay in the public selection', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  for (const file of [
    'test/entity-upsert-mention-scope.test.js',
    'test/startup-recall-races.test.js',
    'test/startup-thread-index.test.js',
    'test/thread-index-startup.test.js',
  ]) {
    assert.ok(resolved.selectedFiles.includes(file), `${file} needs no private memory fixtures`);
    assert.ok(!resolved.excludedFiles.includes(file), `${file} must remain public`);
  }
});
