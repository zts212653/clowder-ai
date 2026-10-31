import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { acquireAgyNativeProfileTurn } from '../dist/domains/cats/services/agents/providers/agy-native/agy-native-profile-turn.js';
import { acquireAgyNativeProfileTurnAsync } from '../dist/domains/cats/services/agents/providers/agy-native/profile-turn/async.js';
import { retiredProcessIdentity } from './helpers/retired-process-identity.js';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'native-async-lease-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, '.cat-cafe-native-turn.sqlite');
  return { home, path };
}

for (const redirected of [false, true]) {
  test(`async orphan retirement retains credential scope and ancestor checks (redirected=${redirected})`, async (t) => {
    const retired = await retiredProcessIdentity(t);
    const { home, path } = fixture(t);
    const a = join(home, '.cat-cafe-native-runs/run-aaaa');
    const b = join(home, '.cat-cafe-native-runs/run-bbbb');
    const credential = (run) =>
      join(run, '.gemini/config/cat-cafe-credentials/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');
    for (const run of [a, b]) {
      mkdirSync(join(run, '.gemini/config/cat-cafe-credentials'), { recursive: true });
      writeFileSync(credential(run), '{}');
    }
    const release = acquireAgyNativeProfileTurn(home, 'old', { conversationId: 'A', runHome: a });
    try {
      const db = new Database(path);
      const owner = JSON.parse(db.prepare('SELECT owner FROM native_conversation_turn').get().owner);
      owner.identity = retired;
      owner.dataRoot = join(home, 'isolated-data');
      db.prepare('UPDATE native_conversation_turn SET owner = ?').run(JSON.stringify(owner));
      db.close();
      if (redirected) {
        rmSync(a, { recursive: true });
        symlinkSync(b, a, 'dir');
        await assert.rejects(
          acquireAgyNativeProfileTurnAsync(home, 'next', { conversationId: 'A' }),
          /ancestor is unsafe/,
        );
      } else {
        const finish = await acquireAgyNativeProfileTurnAsync(home, 'next', { conversationId: 'A' });
        assert.equal(existsSync(credential(a)), false);
        await assert.rejects(
          acquireAgyNativeProfileTurnAsync(home, 'duplicate', { conversationId: 'A' }),
          /Another native turn/,
        );
        await finish();
      }
      assert.equal(existsSync(credential(b)), true);
    } finally {
      release();
    }
  });
}

test('a concurrent owner replacement fences async process evidence before takeover', async (t) => {
  const deadIdentity = await retiredProcessIdentity(t);
  const { home, path } = fixture(t);
  const release = acquireAgyNativeProfileTurn(home, 'old');
  const db = new Database(path);
  const live = db.prepare('SELECT owner FROM native_profile_turn').get().owner;
  const retired = JSON.parse(live);
  retired.identity = deadIdentity;
  retired.dataRoot = join(home, 'isolated-data');
  db.prepare('UPDATE native_profile_turn SET owner = ?').run(JSON.stringify(retired));
  const original = childProcess.execFile;
  let replaced = false;
  childProcess.execFile = function (command, args, options, callback) {
    if (command === '/bin/ps' && args.includes(String(deadIdentity.pid))) {
      return original.call(this, command, args, options, (...result) => {
        db.prepare('UPDATE native_profile_turn SET token = ?, owner = ?').run('replacement-token', live);
        replaced = true;
        callback(...result);
      });
    }
    return original.call(this, command, args, options, callback);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(acquireAgyNativeProfileTurnAsync(home, 'takeover'), /ownership changed/);
    assert.equal(replaced, true);
    assert.deepEqual(db.prepare('SELECT token, owner FROM native_profile_turn').get(), {
      token: 'replacement-token',
      owner: live,
    });
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
    db.close();
    release();
  }
});

test('async lease release waits for its exact deletion without blocking other API work', async (t) => {
  const { home, path } = fixture(t);
  const release = await acquireAgyNativeProfileTurnAsync(home, 'owner');
  const child = childProcess.fork(new URL('./helpers/managed-job-lock-holder.mjs', import.meta.url), [path], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  await once(child, 'message');
  const start = performance.now();
  const pending = release();
  const synchronousMs = performance.now() - start;
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'release cannot claim success while its row is locked');
  assert.ok(synchronousMs < 200, `release must yield instead of busy-waiting: ${synchronousMs}ms`);
  await pending;
  assert.equal(release(), pending, 'repeated cleanup joins the same exact release');
  const db = new Database(path);
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM native_profile_turn').get().n, 0);
  } finally {
    db.close();
  }
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
});
