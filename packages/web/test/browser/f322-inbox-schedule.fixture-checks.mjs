import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInboxScheduleFixture } from './f322-inbox-schedule.fixture.mjs';

test('original schedule writer creates/deletes once and recovers actual applying state without a second effect', async (t) => {
  const f = await createInboxScheduleFixture('en');
  t.after(() => f.close());
  const base = `http://127.0.0.1:${f.apiPort}`,
    session = await fetch(base + '/api/session');
  const cookie = session.headers.get('set-cookie').split(';')[0],
    identity = await session.json();
  const headers = {
    cookie,
    origin: 'http://127.0.0.1:4800',
    'x-csrf-token': identity.csrfToken,
    'content-type': 'application/json',
  };
  const source = f.approvalSources;
  const pending = await (await fetch(base + '/api/approval-hub/pending', { headers })).json();
  assert.equal(pending.items.filter((p) => p.sourceFeatureId === 'F139').length, 4);
  for (const record of source.records) {
    const item = pending.items.find((p) => p.proposalId === record.proposalId);
    assert.deepEqual(item.navigation.approvalCardRef, record.envelope.approvalCardRef);
    const denied = await fetch(base + `/api/schedule-proposals/${record.proposalId}/approve`, {
      method: 'POST',
      headers: { origin: headers.origin, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 401);
    assert.equal(source.store.getById(record.proposalId).status, 'pending');
    if (record.action === 'recover') {
      source.failRegistrationOnce();
      const failed = await fetch(base + `/api/schedule-proposals/${record.proposalId}/approve`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      assert.equal(failed.status, 500);
      assert.equal(source.store.getById(record.proposalId).status, 'applying');
      const recovering = await (await fetch(base + '/api/approval-hub/pending', { headers })).json();
      assert.equal(recovering.items.find((p) => p.proposalId === record.proposalId).decisionMode, undefined);
      const reject = await fetch(base + `/api/schedule-proposals/${record.proposalId}/reject`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      assert.equal(reject.status, 409);
    }
    const response = await fetch(
      base + `/api/schedule-proposals/${record.proposalId}/${record.action === 'reject' ? 'reject' : 'approve'}`,
      { method: 'POST', headers, body: '{}' },
    );
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  }
  const effects = await source.effects();
  assert.deepEqual(effects.tasks.map((t) => t.id).sort(), ['private-schedule-create', 'private-schedule-recover']);
  assert.deepEqual(effects.registered.sort(), ['private-schedule-create', 'private-schedule-recover']);
  assert.equal(effects.proposals.filter((p) => p.effectCheckpoint?.kind === 'create').length, 2);
  assert.equal(effects.proposals.filter((p) => p.effectCheckpoint?.kind === 'delete').length, 1);
  assert.equal(source.store.getById('schedule-reject').status, 'rejected');
  assert.ok(effects.proposals.filter((p) => p.status === 'approved').every((p) => p.effectCheckpoint));
});
