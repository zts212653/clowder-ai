import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readPackageCapabilityRejection } from '../dist/domains/plugin/read-package-capabilities.js';

const declaration = {
  protocolVersion: 1,
  operations: [
    'detect',
    'configure',
    'login',
    'readRoles',
    'writeRole',
    'openSession',
    'startTurn',
    'cancel',
    'release',
  ],
  transports: ['native', 'acp', 'a2a'],
};
const managedModule = { runtime: { transport: 'builtin', entrypoint: 'dist/index.js' } };

test('Agent access capability is opt-in and accepts a compatible checked module', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-agent-access-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readPackageCapabilityRejection({}, root), undefined);
  await writeFile(join(root, 'agent-access.json'), JSON.stringify(declaration));
  assert.equal(await readPackageCapabilityRejection(managedModule, root), undefined);
  assert.match(await readPackageCapabilityRejection({}, root), /Agent access.*module/i);
});

test('Agent access admission rejects incompatible versions and incomplete operations before replacement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-agent-access-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'agent-access.json');
  await writeFile(path, JSON.stringify({ ...declaration, protocolVersion: 2 }));
  assert.match(await readPackageCapabilityRejection(managedModule, root), /Agent access.*protocol version/i);
  await writeFile(path, JSON.stringify({ ...declaration, operations: ['detect'] }));
  assert.match(await readPackageCapabilityRejection(managedModule, root), /Agent access.*operations/i);
});
