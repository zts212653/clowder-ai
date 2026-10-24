import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { withSecretToolGuard } from './secret-tool-io.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const args of [
  { paths: ['/work/ordinary.md', '/work/.env.local'] },
  { file_paths: ['/work/.env.local'] },
  { files: ['/work/.env.local'] },
  { filenames: ['/work/.env.local'] },
  { absolutePaths: ['/work/.env.local'] },
  { target_files: ['/work/.env.local'] },
  { searchPaths: ['/work/.env.local'] },
  { uris: ['file:///work/.env.local'] },
  { urls: ['file:///work/.env.local'] },
  { options: { paths: [['/work/.env.local']] } },
  { files: [{ path: '/work/.env.local' }] },
  { filename: '/work/.env.local' },
  '/work/.env.local',
])
  test(`blocks credential path leaves before a multi-file read: ${JSON.stringify(args)}`, async () => {
    let calls = 0;
    const notices = [];
    const result = await withSecretToolGuard(
      'read_multiple_files',
      args,
      async () => {
        calls++;
        return { content: [{ type: 'text', text: 'opaque fixture credential' }] };
      },
      { notify: async (notice) => notices.push(notice) },
    );
    assert.equal(calls, 0);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /credential_source_blocked_before_read/);
    assert.equal(notices.length, 0);
  });

test('checks configured credential aliases inside plural and nested path values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plural-credential-path-'));
  roots.push(root);
  const source = join(root, 'session.json');
  const alias = join(root, 'notes.json');
  writeFileSync(source, 'opaque fixture credential');
  symlinkSync(source, alias);
  const saved = process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
  process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE = source;
  try {
    for (const args of [{ paths: [alias] }, { options: { filePaths: [[pathToFileURL(alias).href]] } }]) {
      let calls = 0;
      const result = await withSecretToolGuard('read_multiple_files', args, async () => {
        calls++;
        return {};
      });
      assert.equal(calls, 0);
      assert.equal(result.isError, true);
    }
  } finally {
    if (saved === undefined) delete process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
    else process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE = saved;
  }
});

test('preserves ordinary path lists and search text mentioning a credential filename', async () => {
  const args = { paths: ['/work/README.md', '/work/.env.example'], query: '.env.local' };
  let calls = 0;
  const result = await withSecretToolGuard('read_multiple_files', args, async (input) => {
    calls++;
    assert.deepEqual(input, args);
    return { content: [{ type: 'text', text: 'ordinary result' }] };
  });
  assert.equal(calls, 1);
  assert.equal(result.content[0].text, 'ordinary result');
});
