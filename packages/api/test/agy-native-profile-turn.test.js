import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { retiredProcessIdentity } from './helpers/retired-process-identity.js';

const moduleUrl = new URL(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-profile-turn.js',
  import.meta.url,
);
const { acquireAgyNativeProfileTurn, waitForAgyNativeProfileTurn } = await import(moduleUrl.href);
const { readUnixProcessSnapshotSync, sameUnixProcess } = await import('../dist/utils/cli-process-ownership.js');

test('conversation leases allow other conversations and retain same-conversation cancellation/drain fencing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'f325-conversation-lease-'));
  const releases = [];
  try {
    releases.push(acquireAgyNativeProfileTurn(home, 'first', { conversationId: 'A' }));
    releases.push(acquireAgyNativeProfileTurn(home, 'other', { conversationId: 'B' }));
    assert.throws(() => acquireAgyNativeProfileTurn(home, 'duplicate', { conversationId: 'A' }), /Another native turn/);
    const cancel = new AbortController();
    const canceledWait = waitForAgyNativeProfileTurn(home, 'canceled', cancel.signal, { conversationId: 'A' });
    cancel.abort();
    await assert.rejects(canceledWait, { name: 'AbortError' });
    releases[0]();
    releases.push(acquireAgyNativeProfileTurn(home, 'next-a', { conversationId: 'A' }));
    assert.throws(
      () => acquireAgyNativeProfileTurn(home, 'duplicate-b', { conversationId: 'B' }),
      /Another native turn/,
    );
  } finally {
    for (const release of releases) release();
    rmSync(home, { recursive: true, force: true });
  }
});

test('Native profile takeover waits for dead owner descendants, then retires only orphan credentials', async () => {
  const home = mkdtempSync(join(tmpdir(), 'f325-profile-owner-'));
  const credentials = join(home, '.gemini/config/cat-cafe-credentials');
  mkdirSync(credentials, { recursive: true, mode: 0o700 });
  const credential = join(credentials, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');
  writeFileSync(credential, '{"invocationId":"orphan","callbackToken":"fixture"}', { mode: 0o600 });
  const owner = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { spawn } from 'node:child_process';
    import { acquireAgyNativeProfileTurn } from ${JSON.stringify(moduleUrl.href)};
    acquireAgyNativeProfileTurn(process.env.HOME, 'orphan');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    descendant.unref();
    console.log(JSON.stringify({ pid: descendant.pid }));
    setInterval(() => {}, 1000);
  `,
    ],
    { env: { ...process.env, HOME: home, CAT_CAFE_DATA_DIR: join(home, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let descendant;
  try {
    const [data] = await once(owner.stdout, 'data');
    const { pid } = JSON.parse(data.toString());
    descendant = readUnixProcessSnapshotSync({ pids: [pid] })?.get(pid);
    assert.ok(descendant);
    assert.throws(() => acquireAgyNativeProfileTurn(home, 'successor'), /Another native turn/);
    owner.kill('SIGTERM');
    await once(owner, 'exit');
    assert.throws(() => acquireAgyNativeProfileTurn(home, 'successor'), /Another native turn/);
    assert.ok(existsSync(credential), 'a live descendant can still use the credential');
    process.kill(pid, 'SIGTERM');
    for (
      let i = 0;
      i < 100 && sameUnixProcess(descendant, readUnixProcessSnapshotSync({ pids: [pid] })?.get(pid));
      i++
    ) {
      await delay(20);
    }
    assert.equal(sameUnixProcess(descendant, readUnixProcessSnapshotSync({ pids: [pid] })?.get(pid)), false);
    const release = acquireAgyNativeProfileTurn(home, 'successor');
    assert.equal(existsSync(credential), false);
    release();
    const next = acquireAgyNativeProfileTurn(home, 'next');
    next();
  } finally {
    owner.kill('SIGTERM');
    if (
      descendant &&
      sameUnixProcess(descendant, readUnixProcessSnapshotSync({ pids: [descendant.pid] })?.get(descendant.pid))
    ) {
      process.kill(descendant.pid, 'SIGTERM');
    }
    rmSync(home, { recursive: true, force: true });
  }
});

for (const redirected of [false, true]) {
  test(`orphan cleanup is scoped to its own run (redirected=${redirected})`, async (t) => {
    const retired = await retiredProcessIdentity(t);
    const home = mkdtempSync(join(tmpdir(), 'f325-orphan-scope-'));
    const a = join(home, '.cat-cafe-native-runs/run-aaaa');
    const b = join(home, '.cat-cafe-native-runs/run-bbbb');
    const path = (run) => join(run, '.gemini/config/cat-cafe-credentials/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');
    for (const run of [a, b]) {
      mkdirSync(join(run, '.gemini/config/cat-cafe-credentials'), { recursive: true });
      writeFileSync(path(run), '{}');
    }
    const releaseA = acquireAgyNativeProfileTurn(home, 'dead-a', { conversationId: 'A', runHome: a });
    const releaseB = acquireAgyNativeProfileTurn(home, 'live-b', { conversationId: 'B', runHome: b });
    try {
      const db = new Database(join(home, '.cat-cafe-native-turn.sqlite'));
      const owner = JSON.parse(
        db.prepare('SELECT owner FROM native_conversation_turn WHERE conversation_id = ?').get('A').owner,
      );
      owner.identity = retired;
      owner.dataRoot = join(home, 'isolated-data');
      db.prepare('UPDATE native_conversation_turn SET owner = ? WHERE conversation_id = ?').run(
        JSON.stringify(owner),
        'A',
      );
      db.close();
      if (redirected) {
        rmSync(a, { recursive: true });
        symlinkSync(b, a, 'dir');
        assert.throws(() => acquireAgyNativeProfileTurn(home, 'next-a', { conversationId: 'A' }), /ancestor is unsafe/);
      } else {
        const release = acquireAgyNativeProfileTurn(home, 'next-a', { conversationId: 'A' });
        assert.equal(existsSync(path(a)), false);
        release();
      }
      assert.equal(existsSync(path(b)), true, 'unrelated live credential survives');
      assert.throws(() => acquireAgyNativeProfileTurn(home, 'next-b', { conversationId: 'B' }), /Another native turn/);
    } finally {
      releaseA();
      releaseB();
      rmSync(home, { recursive: true, force: true });
    }
  });
}
