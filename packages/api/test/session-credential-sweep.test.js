import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { writeSessionCredentialFile } from '../dist/domains/cats/services/agents/providers/session-credential-file.js';

const originalOpen = fs.promises.opendir;
const originalStat = fs.promises.stat;
const originalSyncRead = fs.readdirSync;
const originalSyncStat = fs.statSync;
const previousDir = process.env.CAT_CAFE_MCP_CREDS_DIR;
let directory;
let active;
let opens;
let openGate;
let failNextOpen;

const payload = (id = 'one') => ({
  CAT_CAFE_THREAD_ID: 'synthetic-thread',
  CAT_CAFE_CAT_ID: 'synthetic-cat',
  CAT_CAFE_INVOCATION_ID: id,
  CAT_CAFE_CALLBACK_TOKEN: `synthetic-test-value-${id}`,
});

async function until(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), 'Owned asynchronous cleanup must settle within the fixture budget');
}

beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'task229-synthetic-credentials-'));
  process.env.CAT_CAFE_MCP_CREDS_DIR = directory;
  active = 0;
  opens = 0;
  openGate = undefined;
  failNextOpen = false;
  mock.method(fs.promises, 'opendir', async (...args) => {
    if (String(args[0]) !== directory) return originalOpen(...args);
    opens++;
    active++;
    try {
      if (openGate) await openGate;
      if (failNextOpen) {
        failNextOpen = false;
        throw new Error('synthetic directory unavailable');
      }
      const handle = await originalOpen(...args);
      return (async function* () {
        try {
          for await (const entry of handle) yield entry;
        } finally {
          active--;
        }
      })();
    } catch (error) {
      active--;
      throw error;
    }
  });
  syncBuiltinESMExports();
});

afterEach(async () => {
  await until(() => active === 0);
  mock.restoreAll();
  syncBuiltinESMExports();
  if (previousDir === undefined) delete process.env.CAT_CAFE_MCP_CREDS_DIR;
  else process.env.CAT_CAFE_MCP_CREDS_DIR = previousDir;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('credential publication does no synchronous directory walk for unrelated fresh files', async () => {
  for (let index = 0; index < 128; index++) fs.writeFileSync(join(directory, `fresh-${index}.json`), '{}');
  let directoryReads = 0;
  let metadataReads = 0;
  const read = mock.method(fs, 'readdirSync', (...args) => {
    if (String(args[0]) === directory) directoryReads++;
    return originalSyncRead(...args);
  });
  const stat = mock.method(fs, 'statSync', (...args) => {
    if (String(args[0]).startsWith(`${directory}/`)) metadataReads++;
    return originalSyncStat(...args);
  });
  syncBuiltinESMExports();
  const path = join(directory, 'published.json');
  assert.equal(writeSessionCredentialFile(undefined, path), false);
  assert.equal(writeSessionCredentialFile(payload(), path), true);
  read.mock.restore();
  stat.mock.restore();
  syncBuiltinESMExports();
  assert.equal(directoryReads, 0, 'Publication must not synchronously enumerate unrelated files');
  assert.equal(metadataReads, 0, 'Publication must not synchronously stat unrelated files');
  await until(() => active === 0);
});

test('cleanup retains the exact 48-hour boundary, fresh files and non-json entries', async () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const cutoff = now - 48 * 60 * 60 * 1000;
  mock.method(Date, 'now', () => now);
  for (const [name, mtime] of [
    ['expired.json', cutoff - 1000],
    ['boundary.json', cutoff],
    ['fresh.json', now],
    ['old.txt', cutoff - 1000],
  ]) {
    const path = join(directory, name);
    fs.writeFileSync(path, '{}');
    fs.utimesSync(path, mtime / 1000, mtime / 1000);
  }
  assert.equal(writeSessionCredentialFile(payload(), join(directory, 'published.json')), true);
  await until(() => active === 0);
  assert.equal(fs.existsSync(join(directory, 'expired.json')), false);
  for (const name of ['boundary.json', 'fresh.json', 'old.txt', 'published.json'])
    assert.ok(fs.existsSync(join(directory, name)));
});

test('pending same-directory cleanup coalesces while a resumed credential is already current and private', async () => {
  let release;
  openGate = new Promise((resolve) => {
    release = resolve;
  });
  const path = join(directory, 'published.json');
  try {
    assert.equal(writeSessionCredentialFile(payload('one'), path), true);
    assert.equal(writeSessionCredentialFile(payload('two'), path), true);
    const saved = JSON.parse(fs.readFileSync(path, 'utf8'));
    assert.equal(saved.invocationId, 'two');
    assert.equal(saved.callbackToken, 'synthetic-test-value-two');
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
    assert.equal(opens, 1, 'Concurrent publications must share the pending directory walk');
  } finally {
    release();
  }
  await until(() => active === 0);
});

test('a credential refreshed after asynchronous stale metadata is retained', async () => {
  const path = join(directory, 'refreshed.json');
  fs.writeFileSync(path, '{}');
  const old = (Date.now() - 49 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path, old, old);
  let refreshed = false;
  mock.method(fs.promises, 'stat', async (...args) => {
    const metadata = await originalStat(...args);
    if (String(args[0]) === path && !refreshed) {
      refreshed = true;
      assert.equal(writeSessionCredentialFile(payload('renewed'), path), true);
    }
    return metadata;
  });
  syncBuiltinESMExports();
  assert.equal(writeSessionCredentialFile(payload(), join(directory, 'published.json')), true);
  await until(() => active === 0);
  assert.ok(refreshed, 'Exercise the asynchronous stat-to-delete renewal window');
  assert.equal(JSON.parse(fs.readFileSync(path, 'utf8')).invocationId, 'renewed');
});

test('a failed asynchronous walk cannot reject publication or prevent a later cleanup', async () => {
  const path = join(directory, 'expired.json');
  fs.writeFileSync(path, '{}');
  const old = (Date.now() - 49 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path, old, old);
  failNextOpen = true;
  assert.equal(writeSessionCredentialFile(payload('one'), join(directory, 'published.json')), true);
  await until(() => active === 0);
  assert.ok(fs.existsSync(path), 'The deliberately failed walk leaves cleanup pending');
  assert.equal(writeSessionCredentialFile(payload('two'), join(directory, 'published.json')), true);
  await until(() => active === 0);
  assert.equal(fs.existsSync(path), false);
  assert.equal(opens, 2);
});
