import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.join(import.meta.dirname, 'scripts', 'verify-runtime-archives.mjs');
const names = [
  'node.tar.gz',
  'deploy-dependencies.tar.gz',
  'deploy-api.tar.gz',
  'deploy-web.tar.gz',
  'deploy-mcp-server.tar.gz',
  'electron.tar.gz',
];

function makeRoot({ empty = false, missingSidecar = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-archives-'));
  const dir = path.join(root, 'bundled', 'archives');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const archive = path.join(dir, name);
    fs.writeFileSync(archive, empty ? '' : 'archive');
    if (name !== 'node.tar.gz' && !missingSidecar) {
      fs.writeFileSync(`${archive}.json`, JSON.stringify({ archive: name, bytes: 7 }));
    }
  }
  return root;
}

test('runtime archive gate rejects zero-byte archives and missing sidecars', () => {
  const empty = makeRoot({ empty: true });
  const emptyResult = spawnSync(process.execPath, [script, empty], { encoding: 'utf8' });
  assert.notEqual(emptyResult.status, 0);
  assert.match(emptyResult.stdout, /empty or not a file/);
  fs.rmSync(empty, { recursive: true, force: true });

  const missingSidecar = makeRoot({ missingSidecar: true });
  const missingResult = spawnSync(process.execPath, [script, missingSidecar], { encoding: 'utf8' });
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stdout, /missing or invalid sidecar/);
  fs.rmSync(missingSidecar, { recursive: true, force: true });
});

test('runtime archive gate accepts all non-empty archives with matching sidecars', () => {
  const root = makeRoot();
  const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok": true/);
  fs.rmSync(root, { recursive: true, force: true });
});
