import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInboxInformationFixture } from './f322-inbox-information.fixture.mjs';
import { createInboxMemoryCorrectionFixture } from './f322-inbox-memory-correction.fixture.mjs';

async function ownerClient(f) {
  const base = `http://127.0.0.1:${f.apiPort}`;
  const session = await fetch(base + '/api/session');
  const identity = await session.json();
  const headers = {
    cookie: session.headers.get('set-cookie').split(';')[0],
    origin: 'http://127.0.0.1:4800',
    'x-csrf-token': identity.csrfToken,
    'content-type': 'application/json',
  };
  return {
    identity,
    get: async (path) => (await fetch(base + path, { headers })).json(),
    post: (path) => fetch(base + path, { method: 'POST', headers, body: '{}' }),
  };
}
function recovery(item) {
  assert.equal(item.resolution, 'accepted');
  assert.equal(item.materialization.state, 'outcome_unknown');
  assert.equal(item.inlineApprovable, false);
  assert.equal(item.decisionMode, undefined);
}
test('original F321 resume replays the committed SQLite effect after finalization interruption', async (t) => {
  const f = await createInboxMemoryCorrectionFixture('en', { withRecovery: true });
  t.after(() => f.close());
  const c = await ownerClient(f),
    source = f.approvalSources,
    record = source.records.find((r) => r.verb === 'recover');
  const path = `/api/event-memory-corrections/${record.proposalId}`;
  source.failFinalizationOnce();
  assert.equal((await c.post(path + '/approve')).status, 500);
  const before = (await source.effects()).find((r) => r.verb === 'recover');
  assert.equal(before.proposal.status, 'approving');
  assert.equal(before.event.summary, before.proposal.suggestedPatch.summary);
  assert.ok(before.evidence);
  const item = (await c.get('/api/approval-hub/pending')).items.find((i) => i.proposalId === record.proposalId);
  recovery(item);
  assert.deepEqual(item.navigation.approvalCardRef, record.envelope.approvalCardRef);
  assert.equal((await c.post(path + '/reject')).status, 409);
  const result = await c.post(path + '/approve'),
    body = await result.json();
  assert.equal(result.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'approved');
  assert.equal(body.replayed, true);
  const after = (await source.effects()).find((r) => r.verb === 'recover');
  assert.equal(after.proposal.appliedRevision, before.evidence.revision);
  assert.deepEqual(after.evidence, before.evidence);
  assert.equal(after.event.updatedAt, before.event.updatedAt);
  assert.ok(!(await c.get('/api/approval-hub/pending')).items.some((i) => i.proposalId === record.proposalId));
});
test('original F221 recovery keeps its verified card proof and writes one checkpointed vignette', async (t) => {
  const f = await createInboxInformationFixture('en');
  t.after(() => f.close());
  const c = await ownerClient(f),
    source = f.approvalSources,
    record = source.records.find((r) => r.kind === 'F221' && r.verb === 'approve');
  const path = `/api/taste-proposals/${record.proposalId}`;
  source.failTasteFinalizationOnce();
  assert.equal((await c.post(path + '/approve')).status, 500);
  const before = source.taste.get(record.proposalId);
  assert.equal(before.status, 'approving');
  assert.ok(before.vignettePath);
  const pending = await c.get('/api/concierge/work/decisions?view=unified&offset=0&limit=20');
  const row = pending.items.find((i) => i.approval?.proposalId === record.proposalId);
  recovery(row.approval);
  assert.deepEqual(row.originalApprovalCard.cardRef, { ...record.envelope.approvalCardRef, blockId: record.block.id });
  assert.deepEqual(row.originalApprovalCard.block, record.block);
  assert.equal((await c.get(path)).status, 'approving');
  assert.equal((await c.post(path + '/reject')).status, 409);
  const result = await c.post(path + '/approve'),
    body = await result.json();
  assert.equal(result.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'approved');
  assert.equal(body.recovered, true);
  assert.equal(body.vignettePath, before.vignettePath);
  assert.equal((await source.effects()).vignettes.length, 1);
  assert.ok(!(await c.get('/api/approval-hub/pending')).items.some((i) => i.proposalId === record.proposalId));
});
