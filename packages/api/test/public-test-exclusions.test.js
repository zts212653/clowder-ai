import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const registryPath = resolve(packageRoot, 'config/public-test-exclusions.json');
const resolverModuleUrl = pathToFileURL(resolve(packageRoot, 'scripts/resolve-public-test-files.mjs')).href;

const LEGACY_EXCLUSIONS = [
  'redis-',
  'concurrent-fault-drill',
  'task-progress-store',
  'session-strategy-phase3',
  'signal-article-store',
  'persistence-fault-drill',
  'cursor-store-atomicity',
  'workflow-sop-store',
  'dare-agent-service',
  'dare-l1-acceptance',
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
  'process-liveness-probe\\.test',
  'expedition-bootstrap\\.test',
  'rules-route\\.test',
  'root-md-slim\\.test',
  'audit-cc-system-prompt\\.test',
  'f188-cold-start-fixtures\\.test',
  'f188-harness-consistency\\.test',
  'orphan-chrome-cleaner\\.test',
  'capabilities-route\\.test',
  'antigravity-run-command-executor\\.test',
  'f203-phase-i-opencode-l0\\.test',
  'github-schedule-factories\\.test',
  'harness-eval/eval-hub-read-model\\.test',
  'harness-eval/merge-gate-provenance-contract\\.test',
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

function applyLegacySelection(files) {
  const patterns = LEGACY_EXCLUSIONS.map((value) => new RegExp(value));
  return files.filter((file) => patterns.every((pattern) => !pattern.test(file))).sort();
}

test('registry preserves metadata for active legacy exclusions and drops stale ones', async () => {
  const { loadPublicTestExclusions } = await import(resolverModuleUrl);
  const registry = await loadPublicTestExclusions({ configPath: registryPath });

  assert.equal(registry.version, 1);
  assert.equal(
    registry.entries.some((entry) => entry.match === 'antigravity-cdp-client\\.test'),
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
      expiresOn: '2026-06-30',
    },
  );
});

test('resolver preserves legacy public test file selection parity', async () => {
  const { resolvePublicTestFiles } = await import(resolverModuleUrl);
  const allTestFiles = await listTestFiles(resolve(packageRoot, 'test'));
  const expected = applyLegacySelection(allTestFiles);

  const resolved = await resolvePublicTestFiles({
    packageRoot,
    configPath: registryPath,
  });

  assert.deepEqual(resolved.selectedFiles, expected);
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
              expiresOn: '2026-06-30',
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
              expiresOn: '2026-06-30',
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
