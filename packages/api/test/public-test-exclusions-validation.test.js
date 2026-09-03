import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const resolverModuleUrl = pathToFileURL(resolve(packageRoot, 'scripts/resolve-public-test-files.mjs')).href;
const AUDIT_SOURCE_HEAD = 'b741f42fdbbb4484a54cde7eadca08b3b11652e3';
const AUDIT_PUBLIC_HEAD = '182d8ec9abc87ff7905441dca0575aab9787ee8f';

function auditFor(matchedFiles, overrides = {}) {
  const normalized = [...matchedFiles].sort();
  return {
    reviewedOn: '2026-09-01',
    sourceHead: AUDIT_SOURCE_HEAD,
    publicHead: AUDIT_PUBLIC_HEAD,
    status: 'source_dependency_failure',
    matchedFileCount: normalized.length,
    matchedFilesHash: createHash('sha256')
      .update(JSON.stringify({ matchedFiles: normalized }))
      .digest('hex'),
    ...overrides,
  };
}

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

test('validator rejects malformed, expired, or zero-match exclusion entries', async () => {
  const { validatePublicTestExclusions } = await import(resolverModuleUrl);
  const allTestFiles = await listTestFiles(resolve(packageRoot, 'test'));

  assert.throws(
    () =>
      validatePublicTestExclusions(
        {
          version: 2,
          entries: [
            {
              id: 'missing-owner',
              match: 'governance-status\\.test',
              category: 'source_only',
              reason: 'missing owner should fail',
              introducedBy: 'deadbeef0',
              expiresOn: '2026-07-31',
              audit: auditFor(['test/governance-status.test.js']),
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
          version: 2,
          entries: [
            {
              id: 'expired',
              match: 'governance-status\\.test',
              category: 'source_only',
              reason: 'expired should fail',
              owner: '@zts212653',
              introducedBy: 'deadbeef1',
              expiresOn: '2026-06-01',
              audit: auditFor(['test/governance-status.test.js']),
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
          version: 2,
          entries: [
            {
              id: 'zero-match',
              match: 'this-test-does-not-exist\\.test',
              category: 'source_only',
              reason: 'stale entry should fail',
              owner: '@zts212653',
              introducedBy: 'deadbeef2',
              expiresOn: '2026-07-31',
              audit: auditFor(['test/governance-status.test.js']),
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

  for (const [id, expiresOn, expectedError] of [
    ['loose-format-no-zero-pad', '2026-6-23', /YYYY-MM-DD/i],
    ['word-sentinel', 'never', /YYYY-MM-DD/i],
    ['slash-separator', '2026/06/23', /YYYY-MM-DD/i],
    ['invalid-calendar-date', '2026-13-99', /valid calendar date/i],
  ]) {
    assert.throws(
      () =>
        validatePublicTestExclusions(
          {
            version: 2,
            entries: [
              {
                id,
                match: 'governance-status\\.test',
                category: 'source_only',
                reason: 'invalid exclusion expiry must fail closed',
                owner: '@zts212653',
                introducedBy: 'deadbeef3',
                expiresOn,
                audit: auditFor(['test/governance-status.test.js']),
              },
            ],
          },
          { allTestFiles, today: '2026-06-16' },
        ),
      expectedError,
    );
  }
});

test('validator requires a v2 audit for every live exclusion', async () => {
  const { validatePublicTestExclusions } = await import(resolverModuleUrl);
  assert.throws(
    () =>
      validatePublicTestExclusions(
        {
          version: 2,
          entries: [
            {
              id: 'missing-audit',
              match: 'governance-status\\.test',
              category: 'source_only',
              reason: 'an exclusion without evidence must fail closed',
              owner: '@zts212653',
              introducedBy: 'deadbeef7',
              expiresOn: '2026-10-01',
            },
          ],
        },
        { allTestFiles: ['test/governance-status.test.js'], today: '2026-09-01' },
      ),
    /audit/i,
  );
});

test('validator rejects an audited exclusion when its matched test inventory drifts', async () => {
  const { validatePublicTestExclusions } = await import(resolverModuleUrl);
  const baselineFiles = ['test/governance-status.test.js'];
  const entry = {
    id: 'audited-inventory',
    match: 'governance-status',
    category: 'source_only',
    reason: 'the audit must bind to the exact public candidate inventory',
    owner: '@zts212653',
    introducedBy: 'deadbeef8',
    expiresOn: '2026-10-01',
    audit: auditFor(baselineFiles),
  };

  assert.doesNotThrow(() =>
    validatePublicTestExclusions(
      { version: 2, entries: [entry] },
      { allTestFiles: baselineFiles, today: '2026-09-01' },
    ),
  );
  assert.throws(
    () =>
      validatePublicTestExclusions(
        { version: 2, entries: [entry] },
        {
          allTestFiles: [...baselineFiles, 'test/governance-status-replay.test.js'],
          today: '2026-09-01',
        },
      ),
    /audited match inventory/i,
  );
});

test('validator binds source and public test inventories to separate explicit audit profiles', async () => {
  const { validatePublicTestExclusions } = await import(resolverModuleUrl);
  const sourceFiles = ['test/redis-source-store.test.js'];
  const publicFiles = [...sourceFiles, 'test/redis-community-store.test.js'];
  const entry = {
    id: 'redis-profiled-inventory',
    match: 'redis-',
    category: 'source_only',
    reason: 'the public candidate adds one explicitly target-owned community test',
    owner: '@zts212653',
    introducedBy: 'deadbeef9',
    expiresOn: '2026-10-01',
    audit: auditFor(sourceFiles),
    publicAudit: auditFor(publicFiles, { publicHead: '01c58feb40fab2a75016a9a8d290c87f6776d9a0' }),
  };

  assert.doesNotThrow(() =>
    validatePublicTestExclusions(
      { version: 2, entries: [entry] },
      { allTestFiles: sourceFiles, today: '2026-09-02', auditProfile: 'source' },
    ),
  );
  assert.doesNotThrow(() =>
    validatePublicTestExclusions(
      { version: 2, entries: [entry] },
      { allTestFiles: publicFiles, today: '2026-09-02', auditProfile: 'public' },
    ),
  );
  assert.throws(
    () =>
      validatePublicTestExclusions(
        { version: 2, entries: [entry] },
        { allTestFiles: publicFiles, today: '2026-09-02', auditProfile: 'source' },
      ),
    /audited match inventory/i,
  );
});
