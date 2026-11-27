import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readAheadApi } from './api-startup-read-ahead.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
async function fixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-read-ahead-'));
  const entry = path.join(root, 'packages/api/dist/index.desktop.js');
  const manifest = path.join(path.dirname(entry), '.startup-read-ahead.json');
  const dependency = path.join(root, 'node_modules/witness/index.js');
  const code = 'throw new Error("Read-ahead must never execute this module");';
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.mkdir(path.dirname(dependency), { recursive: true });
  await fs.writeFile(entry, 'export const value = 1;');
  await fs.writeFile(dependency, code);
  const record = {
    version: 1,
    entrySha256: digest(await fs.readFile(entry)),
    files: [{ relative: 'node_modules/witness/index.js', bytes: Buffer.byteLength(code) }],
  };
  try {
    await action({ root, entry, manifest, dependency, record });
  } finally {
    // Fixture contains only generated program files, never a running instance.
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('optional program read-ahead never evaluates modules or writes program bytes', () =>
  fixture(async (f) => {
    await fs.writeFile(f.manifest, JSON.stringify(f.record));
    const before = await fs.readFile(f.dependency);
    const result = await readAheadApi(f.entry);
    assert.equal(result.status, 'ready');
    assert.equal(result.files, 2); // Entry identity check also warms its bytes.
    assert.deepEqual(await fs.readFile(f.dependency), before);
  }));

test('older installs and development entries continue without a manifest', () =>
  fixture(async (f) => {
    assert.equal((await readAheadApi(f.entry)).status, 'skipped');
    assert.equal((await readAheadApi(path.join(f.root, 'index.js'))).status, 'skipped');
  }));

test('invalid paths, duplicate inputs and excessive budgets are rejected before reading dependencies', () =>
  fixture(async (f) => {
    for (const files of [
      [{ relative: '../instance/home/auth.json', bytes: 1 }],
      [{ relative: '/etc/hosts', bytes: 1 }],
      [{ relative: 'node_modules/../home/auth.json', bytes: 1 }],
      [{ relative: 'node_modules/witness/secret.env', bytes: 1 }],
      [{ relative: 'node_modules/witness/index.js:auth.json', bytes: 1 }],
      [f.record.files[0], f.record.files[0]],
      [{ ...f.record.files[0], bytes: 70 * 1024 * 1024 }],
    ]) {
      await fs.writeFile(f.manifest, JSON.stringify({ ...f.record, files }));
      assert.equal((await readAheadApi(f.entry)).status, 'invalid');
    }
  }));

test('malformed, oversized and stale manifests cannot prevent normal loading', () =>
  fixture(async (f) => {
    for (const data of ['{', ' '.repeat(600000), JSON.stringify({ ...f.record, entrySha256: '0'.repeat(64) })]) {
      await fs.writeFile(f.manifest, data);
      assert.equal((await readAheadApi(f.entry)).status, 'invalid');
    }
  }));

test('missing or changed program inputs are partial hints, not startup failures', () =>
  fixture(async (f) => {
    for (const relative of ['node_modules/missing/index.js', 'node_modules/witness/index.js']) {
      await fs.writeFile(f.manifest, JSON.stringify({ ...f.record, files: [{ relative, bytes: 1 }] }));
      assert.equal((await readAheadApi(f.entry)).status, 'partial');
    }
  }));

test('a junction cannot redirect a program hint into an external HOME', () =>
  fixture(async (f) => {
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'read-ahead-outside-'));
    try {
      await fs.writeFile(path.join(external, 'auth.json'), 'fixture-secret');
      await fs.symlink(
        external,
        path.join(f.root, 'node_modules/outside'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await fs.writeFile(
        f.manifest,
        JSON.stringify({ ...f.record, files: [{ relative: 'node_modules/outside/auth.json', bytes: 14 }] }),
      );
      const reads = [];
      const result = await readAheadApi(f.entry, {
        io: {
          ...fs,
          readFile: async (...args) => {
            reads.push(String(args[0]));
            return fs.readFile(...args);
          },
        },
      });
      assert.equal(result.status, 'partial');
      assert.equal(
        reads.some((file) => file.includes('auth.json')),
        false,
      );
    } finally {
      await fs.rm(external, { recursive: true, force: true });
    }
  }));

test('two readers and a time budget bound speculative I/O, with no new reads after expiry', () =>
  fixture(async (f) => {
    f.record.files = Array.from({ length: 8 }, (_, i) => ({ relative: `node_modules/witness/dep${i}.js`, bytes: 1 }));
    for (const file of f.record.files) await fs.writeFile(path.join(f.root, file.relative), '1');
    await fs.writeFile(f.manifest, JSON.stringify(f.record));
    let active = 0,
      peak = 0,
      calls = 0;
    const io = {
      ...fs,
      readFile: async (file, options) => {
        if (!String(file).includes('/dep') && !String(file).includes('\\dep')) return fs.readFile(file, options);
        calls++;
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 90));
          return await fs.readFile(file, options);
        } finally {
          active--;
        }
      },
    };
    const result = await readAheadApi(f.entry, { io, budgetMs: 40 });
    assert.equal(result.status, 'budget');
    assert.equal(peak, 2);
    const callsAtExpiry = calls;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(calls, callsAtExpiry);
  }));
