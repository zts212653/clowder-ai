import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

test('only the actual owner can discover member resources, and discovery never grants execution or wakes a member', async () => {
  const f = memberSessionFixture();
  let reads = 0;
  const description = {
    schema: 'host.member-resources.v1' as const,
    catId: 'member',
    runtime: { clientId: 'openai', model: 'configured-model', carrier: 'exec_json' },
    available: true,
    accounts: [],
    memory: [],
  };
  const service = createPluginMemberSessions({
    ...f.deps,
    describeResources: async () => {
      reads++;
      return description;
    },
  });
  const describe = service.hostDescribeForInstance(f.scope());
  await assert.rejects(() => describe({ catId: 'member' }), /owner_authority/);
  assert.equal(reads, 0);
  assert.deepEqual(await f.owner(() => describe({ catId: 'member' }), 'automatic-status', false), description);
  assert.equal(reads, 1);
  assert.equal(f.rows.size, 0);
  assert.equal(f.sends(), 0);
  await assert.rejects(
    () => f.owner(() => describe({ catId: 'member', memory: ['arbitrary-path'] })),
    /invalid_member/,
  );
  assert.equal(reads, 1);
});

test('resource discovery rechecks the original owner/activation after provider or profile reads', async () => {
  const f = memberSessionFixture();
  let stopped = false;
  const service = createPluginMemberSessions({
    ...f.deps,
    describeResources: async () => {
      stopped = true;
      return {
        schema: 'host.member-resources.v1' as const,
        catId: 'member',
        available: false,
        accounts: [],
        memory: [],
      };
    },
  });
  const describe = service.hostDescribeForInstance({
    ...f.scope(),
    assertCurrent: async () => {
      if (stopped) throw new Error('activation_stopped');
    },
  });
  await assert.rejects(
    () => f.owner(() => describe({ catId: 'member' }), 'automatic-status', false),
    /activation_stopped/,
  );
  assert.equal(f.rows.size, 0);
});
