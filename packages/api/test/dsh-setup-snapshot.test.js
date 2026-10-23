import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDshDumpSnapshot } from '../dist/routes/dsh-setup-snapshot.js';

test('diagnostic snapshot copies only configuration, detects concurrent changes and disposes only its own copies', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-snapshot-unit-')),
    home = join(root, 'native');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  mkdirSync(join(home, 'profiles/acp'), { recursive: true });
  writeFileSync(join(home, '.credentials.yaml'), 'dummy native credential file');
  writeFileSync(join(home, 'profiles/acp/cordis.yml'), 'original root bytes');
  const snapshot = createDshDumpSnapshot(root, 'acp');
  assert.equal(existsSync(join(snapshot.directory, '.credentials.yaml')), false);
  writeFileSync(join(snapshot.directory, 'profiles/acp/cordis.yml'), 'diagnostic rewrites its own root');
  snapshot.verify();
  assert.equal(readFileSync(join(home, 'profiles/acp/cordis.yml'), 'utf8'), 'original root bytes');
  writeFileSync(join(home, 'profiles/acp/cordis.patch.yml'), 'new concurrent config');
  assert.throws(snapshot.verify, /changed/);
  snapshot.dispose();
  assert.equal(existsSync(snapshot.directory), false);
  assert.deepEqual(readdirSync(root), ['native']);
  assert.equal(readFileSync(join(home, '.credentials.yaml'), 'utf8'), 'dummy native credential file');
});
