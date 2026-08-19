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
  'task-progress-store',
  'session-strategy-phase3',
  'signal-article-store',
  'cursor-store-atomicity',
  'workflow-sop-store',
  'codex-agent-service',
  'kimi-agent-service',
  'claude-settings-hooks\\.test',
  'game-store\\.test',
  'test/memory/',
  'cross-cat-context\\.test',
  'thread-wiring\\.test',
  'integration/wiring\\.test',
  'antigravity-cdp-client\\.test',
  'shared-state-wiring\\.test',
  'signal-fetcher-launchd',
  'reflection-capsule-m3',
  'workspace-project-context\\.test',
  'projects-setup\\.test',
  'projects-mkdir\\.test',
  'governance-status\\.test',
  'governance-pack\\.test',
  'pack-integration\\.test',
  'project-setup-flow\\.test',
  'expedition-bootstrap\\.test',
  'rules-route\\.test',
  'root-md-slim\\.test',
  'audit-cc-system-prompt\\.test',
  'f188-cold-start-fixtures\\.test',
  'f188-harness-consistency\\.test',
  'orphan-chrome-cleaner\\.test',
  'f203-phase-i-opencode-l0\\.test',
  'f236-cc-anchor-hook\\.test',
  'github-schedule-factories\\.test',
  'harness-eval/eval-hub-read-model\\.test',
  'harness-eval/merge-gate-provenance-contract\\.test',
  'f254-(?:freshness-instruction-private-evidence|freshness-replay-provider|manual-reminder-scope|provider-native-freshness)\\.test',
  'harness-eval/eval-hub-(?:lifecycle-summary-route|metric-glossary-coverage|read-model-f248-phase-b2|route)\\.test',
  'harness-eval/(?:friction-measurement-bundle|measurement-bundle-census|measurement-independent-rejudge(?:-adjudication|-judgment)?)\\.test',
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

test('registry preserves metadata for reconciled exclusions and drops retired ones', async () => {
  const { loadPublicTestExclusions } = await import(resolverModuleUrl);
  const registry = await loadPublicTestExclusions({ configPath: registryPath });

  assert.equal(registry.version, 1);
  assert.equal(
    registry.entries.some((entry) => entry.match === 'antigravity-cdp-client\\.test'),
    false,
  );
  assert.equal(
    registry.entries.some((entry) => entry.match === 'capabilities-route\\.test'),
    false,
  );

  const governancePack = registry.entries.find((entry) => entry.match === 'governance-pack\\.test');
  assert.deepEqual(
    governancePack && {
      category: governancePack.category,
      owner: governancePack.owner,
      introducedBy: governancePack.introducedBy,
      expiresOn: governancePack.expiresOn,
    },
    {
      category: 'source_only',
      owner: '@zts212653',
      introducedBy: '069d0f0fb',
      expiresOn: '2026-08-31',
    },
  );
});

test('resolver preserves the reconciled public test file selection', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const allTestFiles = await listTestFiles(resolve(packageRoot, 'test'));
  const expected = applyReconciledSelection(allTestFiles);

  const resolved = await resolvePublicTestFiles({
    packageRoot,
    configPath: registryPath,
  });

  assert.deepEqual(resolved.selectedFiles, expected);
});

test('resolver excludes source-only cc anchor hook coverage from the public gate', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({
    packageRoot,
    configPath: registryPath,
  });

  assert.ok(resolved.excludedFiles.includes('test/f236-cc-anchor-hook.test.js'));
  assert.ok(!resolved.selectedFiles.includes('test/f236-cc-anchor-hook.test.js'));
});

test('resolver excludes private evidence consumers but keeps self-contained public contracts', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({
    packageRoot,
    configPath: registryPath,
  });

  for (const file of [
    'test/f254-freshness-instruction-private-evidence.test.js',
    'test/f254-freshness-replay-provider.test.js',
    'test/f254-provider-native-freshness.test.js',
    'test/harness-eval/measurement-bundle-census.test.js',
    'test/harness-eval/publish-verdict-memory.test.js',
  ]) {
    assert.ok(resolved.excludedFiles.includes(file), `${file} should be private-fixture-only`);
  }
  for (const file of [
    'test/cicd-router.test.js',
    'test/embed-runtime-policy.test.js',
    'test/f254-freshness-instruction-surface.test.js',
    'test/harness-eval/eval-capability-tips-enable-gate.test.js',
    'test/system-prompt-builder.test.js',
    'test/weixin-mp-path-security.test.js',
  ]) {
    assert.ok(resolved.selectedFiles.includes(file), `${file} should remain a public behavior contract`);
  }
});

test('focused public selection accepts only explicit files from the live selected suite', async () => {
  const { resolvePublicTestFiles, selectFocusedPublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({
    packageRoot,
    configPath: registryPath,
  });

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
});

test('resolver re-admits capabilities-route once the product regression is fixed', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const resolved = await resolvePublicTestFiles({
    packageRoot,
    configPath: registryPath,
  });

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
    if (previousPolicyTimezone === undefined) {
      delete process.env.CAT_CAFE_POLICY_TIMEZONE;
    } else {
      process.env.CAT_CAFE_POLICY_TIMEZONE = previousPolicyTimezone;
    }
    if (previousHostTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousHostTimezone;
    }
  }
});

test('validator rejects malformed, expired, or zero-match exclusion entries', async () => {
  const { validatePublicTestExclusions } = await import(resolverModuleUrl);
  const allTestFiles = await listTestFiles(resolve(packageRoot, 'test'));

  assert.throws(
    () =>
      validatePublicTestExclusions(
        {
          version: 1,
          entries: [
            {
              id: 'missing-owner',
              match: 'governance-pack\\.test',
              category: 'source_only',
              reason: 'missing owner should fail',
              introducedBy: 'deadbeef0',
              expiresOn: '2026-07-31',
            },
          ],
        },
        { allTestFiles, today: '2026-06-16' },
      ),
    /owner/i,
  );

  assert.throws(
    () =>
      validatePublicTestExclusions(
        {
          version: 1,
          entries: [
            {
              id: 'expired',
              match: 'governance-pack\\.test',
              category: 'source_only',
              reason: 'expired should fail',
              owner: '@zts212653',
              introducedBy: 'deadbeef1',
              expiresOn: '2026-06-01',
            },
          ],
        },
        { allTestFiles, today: '2026-06-16' },
      ),
    /expired/i,
  );

  assert.throws(
    () =>
      validatePublicTestExclusions(
        {
          version: 1,
          entries: [
            {
              id: 'zero-match',
              match: 'this-test-does-not-exist\\.test',
              category: 'source_only',
              reason: 'stale entry should fail',
              owner: '@zts212653',
              introducedBy: 'deadbeef2',
              expiresOn: '2026-07-31',
            },
          ],
        },
        { allTestFiles, today: '2026-06-16' },
      ),
    /matches no current test/i,
  );
});

test('validator rejects non-ISO YYYY-MM-DD expiresOn formats (codex #2326 P2)', async () => {
  const { validatePublicTestExclusions } = await import(resolverModuleUrl);
  const allTestFiles = await listTestFiles(resolve(packageRoot, 'test'));

  // Non-strict format: zero-padding missing — lexicographic compare would
  // still let it through ("2026-6-23" > "2026-06-16") so format check matters.
  assert.throws(
    () =>
      validatePublicTestExclusions(
        {
          version: 1,
          entries: [
            {
              id: 'loose-format-no-zero-pad',
              match: 'governance-pack\\.test',
              category: 'source_only',
              reason: 'YYYY-M-D should fail strict format check',
              owner: '@zts212653',
              introducedBy: 'deadbeef3',
              expiresOn: '2026-6-23',
            },
          ],
        },
        { allTestFiles, today: '2026-06-16' },
      ),
    /YYYY-MM-DD/i,
  );

  // Word-form sentinel that lexicographic compare would happily let through
  // ("never" > "2026-06-16" lexicographically).
  assert.throws(
    () =>
      validatePublicTestExclusions(
        {
          version: 1,
          entries: [
            {
              id: 'word-sentinel',
              match: 'governance-pack\\.test',
              category: 'source_only',
              reason: 'sentinel like never should fail strict format check',
              owner: '@zts212653',
              introducedBy: 'deadbeef4',
              expiresOn: 'never',
            },
          ],
        },
        { allTestFiles, today: '2026-06-16' },
      ),
    /YYYY-MM-DD/i,
  );

  // Slash separators
  assert.throws(
    () =>
      validatePublicTestExclusions(
        {
          version: 1,
          entries: [
            {
              id: 'slash-separator',
              match: 'governance-pack\\.test',
              category: 'source_only',
              reason: 'YYYY/MM/DD should fail strict format check',
              owner: '@zts212653',
              introducedBy: 'deadbeef5',
              expiresOn: '2026/06/23',
            },
          ],
        },
        { allTestFiles, today: '2026-06-16' },
      ),
    /YYYY-MM-DD/i,
  );

  // Syntactically YYYY-MM-DD but semantically invalid calendar date — Date()
  // will roll 13/99 into a future month, lexicographic compare would accept.
  assert.throws(
    () =>
      validatePublicTestExclusions(
        {
          version: 1,
          entries: [
            {
              id: 'invalid-calendar-date',
              match: 'governance-pack\\.test',
              category: 'source_only',
              reason: 'rolled-over date should fail',
              owner: '@zts212653',
              introducedBy: 'deadbeef6',
              expiresOn: '2026-13-99',
            },
          ],
        },
        { allTestFiles, today: '2026-06-16' },
      ),
    /valid calendar date/i,
  );
});
