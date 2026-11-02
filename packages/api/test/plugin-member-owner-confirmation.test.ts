import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

test('automatic authenticated owner operation reads cannot create a grant', async () => {
  const f = memberSessionFixture(),
    port = createPluginMemberSessions(f.deps).forInstance(f.scope());
  await assert.rejects(
    () => f.owner(() => port.prepare(f.prepareInput), 'automatic-list', false),
    /owner_confirmation_required/,
  );
  assert.equal(f.rows.size, 0);
  assert.equal(f.sends(), 0);
});

test('an authentic unconfirmed owner operation can revoke an existing grant but cannot renew it', async () => {
  const f = memberSessionFixture(),
    port = createPluginMemberSessions(f.deps).forInstance(f.scope());
  const grant = await f.owner(() => port.prepare(f.prepareInput));
  const revoked = await f.owner(() => port.revoke(grant.sessionId), 'owner-pause', false);
  assert.equal(revoked.revoked, true);
  await assert.rejects(
    () => f.owner(() => port.prepare(f.prepareInput), 'unconfirmed-resume', false),
    /owner_confirmation_required/,
  );
  const resumed = await f.owner(() => port.prepare(f.prepareInput), 'confirmed-resume');
  assert.equal(resumed.generation, grant.generation + 1);
});
