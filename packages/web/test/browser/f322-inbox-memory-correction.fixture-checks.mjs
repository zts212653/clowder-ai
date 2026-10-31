import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInboxMemoryCorrectionFixture } from './f322-inbox-memory-correction.fixture.mjs';

test('F322 original correction fixture uses actual owner CSRF and SQLite revision receipts', async (t) => {
  const f = await createInboxMemoryCorrectionFixture('en');
  t.after(() => f.close());
  const base = `http://127.0.0.1:${f.apiPort}`,
    origin = 'http://127.0.0.1:4800';
  const session = await fetch(base + '/api/session');
  const cookie = session.headers.get('set-cookie').split(';')[0],
    identity = await session.json();
  const pending = await fetch(base + '/api/approval-hub/pending', { headers: { cookie } });
  assert.equal(pending.status, 200);
  const items = (await pending.json()).items.filter((item) => item.sourceFeatureId === 'F321');
  assert.equal(items.length, 2);
  for (const record of f.approvalSources.records) {
    const item = items.find((item) => item.proposalId === record.proposalId);
    assert.deepEqual(item.navigation.approvalCardRef, record.envelope.approvalCardRef);
    assert.equal(record.block.actions, undefined);
    const detail = await fetch(base + `/api/memory/events/${record.eventId}`, { headers: { cookie } });
    assert.equal(detail.status, 200);
    const memory = await detail.json();
    assert.equal(memory.ownerUserId, identity.userId);
    assert.equal(memory.correctionProposals.length, 1);
    assert.equal(memory.correctionProposals[0].expectedRevision, item.detail.expectedRevision);
    const url = base + `/api/event-memory-corrections/${record.proposalId}/${record.verb}`;
    const denied = await fetch(url, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    assert.equal((await f.approvalSources.proposals.get(record.proposalId)).status, 'pending');
    const result = await fetch(url, {
      method: 'POST',
      headers: { cookie, origin, 'x-csrf-token': identity.csrfToken, 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await result.json();
    assert.equal(result.status, 200, JSON.stringify(body));
    assert.equal(body.status, record.verb === 'approve' ? 'approved' : 'rejected');
  }
  const effects = await f.approvalSources.effects(),
    applied = effects.find((r) => r.verb === 'approve'),
    refused = effects.find((r) => r.verb === 'reject');
  assert.equal(applied.event.summary, applied.proposal.suggestedPatch.summary);
  assert.equal(applied.evidence.revision, applied.proposal.appliedRevision);
  assert.equal(refused.event.summary, f.approvalSources.records.find((r) => r.verb === 'reject').previous.summary);
  assert.equal(refused.evidence, null);
});
