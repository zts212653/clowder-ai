import assert from 'node:assert/strict';
import test from 'node:test';
import { neutralFixture } from './helpers/neutral-host-fixture.js';

test('the actual module carrier supplies its own installation, owner and activation to the optional member port', async (t) => {
  const admitted = [];
  const f = await neutralFixture(t, {
    memberSessions(scope, signal) {
      admitted.push({ scope, signal });
      return {
        async get(id) {
          await scope.assertCurrent();
          return { id };
        },
      };
    },
  });
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].scope.ownerUserId, f.owner);
  assert.equal(admitted[0].scope.pluginInstanceId, f.installed.pluginInstanceId);
  assert.ok(admitted[0].scope.packageDigest);
  const old = f.host().memberSessions;
  assert.deepEqual(await old.get('own-grant'), { id: 'own-grant' });
  await f.runtime.supervisor.stop(f.installed.pluginInstanceId, 'test_stop');
  assert.equal(admitted[0].signal.aborted, true);
  await assert.rejects(old.get('own-grant'));
  await f.runtime.supervisor.start(f.installed.pluginInstanceId);
  assert.equal(admitted.length, 2);
  await assert.rejects(old.get('own-grant'));
  assert.deepEqual(await f.host().memberSessions.get('own-grant'), { id: 'own-grant' });
});

test('older or persistence-free Hosts expose absence without a synthetic member executor', async (t) => {
  const f = await neutralFixture(t);
  assert.equal(f.host().memberSessions, undefined);
});
