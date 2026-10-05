import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDevelopmentReturnFixture as fixture } from '../helpers/development-return-fixture.js';
import { reviewedExecution } from '../helpers/reviewed-development-return-fixture.js';

for (const scenario of [
  'no-reservation',
  'no-binding',
  'no-record',
  'wrong-author',
  'wrong-user',
  'wrong-thread',
  'wrong-subject',
  'wrong-head',
  'wrong-source',
  'wrong-revision',
  'wrong-reviewer-invocation',
  'wrong-request-invocation',
  'request-deleted',
  'request-edited',
  'record-after-approval',
  'dismissed',
]) {
  test(`recorded review provenance rejects ${scenario} at registration and delivery`, async (t) => {
    const f = await fixture(t);
    const x = await reviewedExecution(f);
    const state = await f.service.register(f.actor, x.input, 'strict');
    const records = await x.ledger.read();
    const reservation = records.find((event) => event.type === 'use_reserved');
    const binding = records.find((event) => event.type === 'use_dispatch_bound');
    const recorded = records.find((event) => event.type === 'use_recorded');
    assert.ok(reservation && binding && recorded);
    switch (scenario) {
      case 'no-reservation':
        records.splice(records.indexOf(reservation), 1);
        break;
      case 'no-binding':
        records.splice(records.indexOf(binding), 1);
        break;
      case 'no-record':
        records.splice(records.indexOf(recorded), 1);
        break;
      case 'wrong-author':
        reservation.authorCatId = 'other';
        break;
      case 'wrong-user':
        reservation.userId = 'other';
        break;
      case 'wrong-thread':
        reservation.threadId = 'other';
        break;
      case 'wrong-subject':
        reservation.reviewSubjectRef = 'task:work:other';
        break;
      case 'wrong-head':
        reservation.reviewedHeadSha = 'e'.repeat(40);
        break;
      case 'wrong-source':
        reservation.acceptedSourceRef = 'thread:other#human';
        break;
      case 'wrong-revision':
        reservation.acceptedRevision = 'other';
        break;
      case 'wrong-reviewer-invocation':
        binding.reviewerInvocationId = 'other';
        break;
      case 'wrong-request-invocation':
        reservation.invocationId = 'other';
        break;
      case 'request-deleted':
        f.messages.softDelete(x.request.id, f.actor.userId);
        break;
      case 'request-edited':
        x.request.content = 'Changed request';
        break;
      case 'record-after-approval':
        recorded.occurredAt = new Date((f.proposals.get(x.proposal.proposalId)?.approvedAt ?? 0) + 1).toISOString();
        break;
      case 'dismissed':
        recorded.use = 'dismissed';
        break;
    }
    x.ledger.read = async () => records;
    await assert.rejects(f.service.register(f.actor, x.input, 'strict'), /human source/);
    f.tick(20000);
    await f.runner.triggerNow(state.registrationId);
    assert.equal(f.service.read(state.registrationId)?.status, 'retired');
    assert.equal(f.wakes.length, 0);
  });
}

test('provenance reader outage does not turn a supported return into source revocation', async (t) => {
  const f = await fixture(t);
  const x = await reviewedExecution(f);
  const state = await f.service.register(f.actor, x.input, 'strict');
  const read = f.service.deps.readReviewProvenance;
  delete f.service.deps.readReviewProvenance;
  f.tick(20000);
  await assert.rejects(
    f.service.execute(state.registrationId, { signal: new AbortController().signal }),
    /reader is unavailable/,
  );
  assert.equal(f.service.read(state.registrationId)?.status, 'waiting');
  f.service.deps.readReviewProvenance = read;
  await f.runner.triggerNow(state.registrationId);
  assert.equal(f.service.read(state.registrationId)?.status, 'delivered');
  assert.equal(f.wakes.length, 1);
});
