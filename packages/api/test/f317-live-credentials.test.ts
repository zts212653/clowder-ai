import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import { LiveNativeCredentials } from '../src/domains/concierge/live/live-native-credentials.js';

test('a call projects only its own active native turn and removes credentials on close', async () => {
  const scope = { userId: 'owner', threadId: 'home', catId: 'codex-astra', callId: 'call' };
  const credentials = await LiveNativeCredentials.create(scope);
  const environment = {
    CAT_CAFE_USER_ID: 'owner',
    CAT_CAFE_THREAD_ID: 'home',
    CAT_CAFE_CAT_ID: 'codex-astra',
    CAT_CAFE_INVOCATION_ID: 'invocation',
    CAT_CAFE_CALLBACK_TOKEN: 'token',
  };
  try {
    await assert.rejects(credentials.bind({ ...environment, CAT_CAFE_THREAD_ID: 'other' }), /scope/);
    await credentials.bind(environment);
    await credentials.started('native', 'first');
    let value = JSON.parse(await readFile(credentials.path, 'utf8'));
    assert.equal(value.turns[0].invocationId, 'invocation');
    assert.equal(value.turns[0].nativeTurnId, 'first');
    assert.equal((await stat(credentials.path)).mode & 0o777, 0o600);
    await credentials.started('native', 'second');
    await credentials.completed('first');
    value = JSON.parse(await readFile(credentials.path, 'utf8'));
    assert.deepEqual(
      value.turns.map((turn: { nativeTurnId: string }) => turn.nativeTurnId),
      ['second'],
    );
    await assert.rejects(credentials.started('foreign', 'third'), /native thread/);
    await credentials.close();
    await assert.rejects(readFile(credentials.path));
    await assert.rejects(credentials.started('native', 'late'), /closed/);
  } finally {
    await credentials.close();
  }
});
