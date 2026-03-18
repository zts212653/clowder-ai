import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const { backfillSourceContent } = await import('../dist/domains/signals/services/backfill-content.js');

describe('backfillSourceContent', () => {
  let tempDir;
  let libraryDir;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'backfill-test-'));
    libraryDir = join(tempDir, 'library');
    await mkdir(join(libraryDir, 'test-source'), { recursive: true });
    await mkdir(join(tempDir, 'inbox'), { recursive: true });
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('skips articles that already have content', async () => {
    const md = `---
id: signal_001
title: "Has Content"
url: https://example.com/has-content
source: test-source
tier: 1
publishedAt: 2026-01-01T00:00:00Z
fetchedAt: 2026-01-01T00:00:00Z
status: inbox
tags: []
---

# Has Content

This article already has body content.
`;
    await writeFile(join(libraryDir, 'test-source', '2026-01-01-has-content.md'), md);

    const result = await backfillSourceContent('test-source', {
      paths: { libraryDir, inboxDir: join(tempDir, 'inbox'), rootDir: tempDir },
    });

    const detail = result.details.find((d) => d.file === '2026-01-01-has-content.md');
    assert.ok(detail, 'should include detail for existing content');
    assert.equal(detail.status, 'skipped');
  });

  it('identifies articles with empty content', async () => {
    const md = `---
id: signal_002
title: "Empty Article"
url: https://example.com/empty
source: test-source
tier: 1
publishedAt: 2026-01-01T00:00:00Z
fetchedAt: 2026-01-01T00:00:00Z
status: inbox
tags: []
---

# Empty Article

`;
    await writeFile(join(libraryDir, 'test-source', '2026-01-01-empty.md'), md);

    const result = await backfillSourceContent('test-source', {
      paths: { libraryDir, inboxDir: join(tempDir, 'inbox'), rootDir: tempDir },
      dryRun: true,
    });

    assert.ok(result.empty > 0, 'should detect empty articles');
    const detail = result.details.find((d) => d.file === '2026-01-01-empty.md');
    assert.ok(detail, 'should include detail for empty article');
    assert.equal(detail.status, 'skipped');
    assert.equal(detail.reason, 'dry run');
  });

  it('returns empty result for non-existent source', async () => {
    const result = await backfillSourceContent('nonexistent', {
      paths: { libraryDir, inboxDir: join(tempDir, 'inbox'), rootDir: tempDir },
    });

    assert.equal(result.total, 0);
    assert.equal(result.source, 'nonexistent');
  });

  it('rejects path traversal in source id', async () => {
    await assert.rejects(
      () =>
        backfillSourceContent('../escape', {
          paths: { libraryDir, inboxDir: join(tempDir, 'inbox'), rootDir: tempDir },
        }),
      /Invalid source id/,
    );
  });

  it('rejects source id with special characters', async () => {
    await assert.rejects(
      () =>
        backfillSourceContent('../../etc/passwd', {
          paths: { libraryDir, inboxDir: join(tempDir, 'inbox'), rootDir: tempDir },
        }),
      /Invalid source id/,
    );
  });
});
