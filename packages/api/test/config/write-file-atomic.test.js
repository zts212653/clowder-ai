import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { writeFileAtomic } = await import('../../dist/config/write-file-atomic.js');

/** F314-8: the one atomic writer behind the catalog, account, credential and plugin config stores. */
describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temp file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    const target = join(dir, 'config.json');
    writeFileSync(target, 'old');
    writeFileAtomic(target, 'new');
    assert.equal(readFileSync(target, 'utf8'), 'new');
    assert.deepEqual(readdirSync(dir), ['config.json']);
  });

  it('applies the caller-owned file mode', { skip: process.platform === 'win32' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-mode-'));
    const target = join(dir, 'credentials.json');
    writeFileAtomic(target, '{}', { mode: 0o600 });
    assert.equal(statSync(target).mode & 0o777, 0o600);
  });

  it('keeps the old file and removes the temp file when verify throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-verify-'));
    const target = join(dir, 'catalog.json');
    writeFileSync(target, 'old');
    let verified = '';
    assert.throws(
      () =>
        writeFileAtomic(target, 'bad', {
          verify: (tempPath) => {
            verified = readFileSync(tempPath, 'utf8');
            throw new Error('invalid catalog');
          },
        }),
      /invalid catalog/,
    );
    assert.equal(verified, 'bad', 'verify sees the new content before the rename');
    assert.equal(readFileSync(target, 'utf8'), 'old');
    assert.deepEqual(readdirSync(dir), ['catalog.json']);
  });

  it('removes the temp file when the rename fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-rename-'));
    const target = join(dir, 'occupied');
    mkdirSync(join(target, 'child'), { recursive: true });
    assert.throws(() => writeFileAtomic(target, 'content'));
    assert.deepEqual(readdirSync(dir), ['occupied']);
  });
});
