import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acpBootstrapDirectoryIdentity } from '../../src/domains/plugin/manager/acp-bootstrap/acp-bootstrap-directory-identity.js';

test('native identities recognize aliases without treating different directories or a missing path as equal', () => {
  const root = mkdtempSync(join(tmpdir(), 'acp-identity-'));
  const first = join(root, 'actual');
  const second = join(root, 'different');
  const alias = join(root, 'alias');
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(acpBootstrapDirectoryIdentity(first));
  assert.equal(acpBootstrapDirectoryIdentity(first), acpBootstrapDirectoryIdentity(alias));
  assert.notEqual(acpBootstrapDirectoryIdentity(first), acpBootstrapDirectoryIdentity(second));
  assert.equal(acpBootstrapDirectoryIdentity(join(root, 'missing')), undefined);
  // The identity helper deliberately does not assert that a link is safe; bootstrap validation still rejects it.
});
