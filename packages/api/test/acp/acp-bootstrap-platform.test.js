import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { basename, dirname, win32 } from 'node:path';
import { test } from 'node:test';
import { resolveAcpBootstrapRoot } from '../../dist/domains/cats/services/agents/providers/acp/acp-bootstrap-cwd.js';

test('Windows ACP bootstrap uses the user temp directory, including a non-system drive', () => {
  // Call the production resolver on every host; no runtime directory is created.
  const root = resolveAcpBootstrapRoot('win32', 'D:\\User temp\\Local\\Temp');
  assert.equal(win32.dirname(root), 'D:\\User temp\\Local\\Temp');
  assert.match(win32.basename(root), /^cat-cafe-acp-bootstrap-/);
});

test('Unix ACP bootstrap keeps its stable /tmp lifetime independently of os.tmpdir()', () => {
  for (const platform of ['darwin', 'linux']) {
    const root = resolveAcpBootstrapRoot(platform, '/var/folders/transient/T');
    assert.equal(dirname(root), '/tmp');
  }
});

test('the native default selects the same platform policy', () => {
  const root = resolveAcpBootstrapRoot();
  assert.equal(dirname(root), process.platform === 'win32' ? tmpdir() : '/tmp');
  assert.match(basename(root), /^cat-cafe-acp-bootstrap-/);
});
