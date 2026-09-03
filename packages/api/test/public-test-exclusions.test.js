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
  'redis-',
  'session-strategy-phase3',
  'workflow-sop-store',
  'codex-agent-service',
  'kimi-agent-service',
  'test/memory/',
  'thread-wiring\\.test',
  'integration/wiring\\.test',
  'shared-state-wiring\\.test',
  'write-vignette-publication-hook\\.test',
  'capability-evolution-evaluation-owner-join\\.test',
  'signal-fetcher-launchd',
  'reflection-capsule-m3',
  'pack-integration\\.test',
  'root-md-slim\\.test',
  'audit-cc-system-prompt\\.test',
  'f188-cold-start-fixtures\\.test',
  'f188-harness-consistency\\.test',
  'f236-cc-anchor-hook\\.test',
  'f296-(?:b3b3-post-compact-hook|session-hook-source-auth)\\.test',
  'harness-eval/eval-hub-read-model\\.test',
  'harness-eval/merge-gate-provenance-contract\\.test',
  'harness-eval/design-gate-episode-source-provider-private-evidence\\.test',
  'f254-(?:freshness-instruction-private-evidence|freshness-replay-provider|manual-reminder-scope|provider-native-freshness)\\.test',
  'harness-eval/eval-hub-(?:lifecycle-summary-route|metric-glossary-coverage|read-model-f248-phase-b2|route)\\.test',
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

test('resolver excludes source-only Claude hook bytes but keeps public F296 composition coverage', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  for (const sourceOnlyTest of [
    'test/f296-b3b3-post-compact-hook.test.js',
    'test/f296-session-hook-source-auth.test.js',
  ]) {
    assert.ok(resolved.excludedFiles.includes(sourceOnlyTest));
  }
  assert.ok(resolved.selectedFiles.includes('test/f296-session-hook-auth.test.js'));
  assert.ok(resolved.selectedFiles.includes('test/f296-claude-project-hook-readiness.test.js'));
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

test('resolver excludes private evidence consumers but keeps self-contained public contracts', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({ packageRoot, configPath: registryPath });
  for (const file of [
    'test/f254-freshness-instruction-private-evidence.test.js',
    'test/f254-freshness-replay-provider.test.js',
    'test/f254-provider-native-freshness.test.js',
    'test/harness-eval/design-gate-episode-source-provider-private-evidence.test.js',
    'test/harness-eval/measurement-decision-proof-resolver.test.js',
    'test/harness-eval/measurement-decision-proof.test.js',
    'test/harness-eval/publish-verdict-memory.test.js',
  ]) {
    assert.ok(resolved.excludedFiles.includes(file), `${file} should be private-fixture-only`);
  }
  for (const file of [
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
