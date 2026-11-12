import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { tasteAdmissionFixture, tasteDraft } from './helpers/taste-admission-fixture.js';

describe('Taste exact source and same-request recovery', () => {
  let fixture;
  beforeEach(async () => {
    fixture = await tasteAdmissionFixture();
  });
  afterEach(async () => {
    await fixture.app.close();
  });

  it('rejects a caller-selected source before creating or reserving a proposal', async () => {
    const origin = await fixture.source();
    const other = await fixture.source({ content: 'Unrelated original message' });
    const response = await fixture.propose(origin, { ...tasteDraft, sourceMessageId: other.id });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error, /authenticated invocation origin/i);
    assert.equal(fixture.store.getDedupProposalId('alice', tasteDraft.clientRequestId), null);
    assert.deepEqual(fixture.store.listPending('alice'), []);
  });

  it('does not replace a missing authenticated message origin with an event or caller ID', async () => {
    const source = await fixture.source();
    for (const sourceMessageId of [undefined, source.id]) {
      const response = await fixture.propose(undefined, { ...tasteDraft, sourceMessageId });
      assert.equal(response.statusCode, 400, response.body);
      assert.match(response.json().error, /exact source message/i);
    }
    assert.equal(fixture.store.getDedupProposalId('alice', tasteDraft.clientRequestId), null);
    assert.deepEqual(fixture.store.listPending('alice'), []);
  });

  it('stores the authenticated origin when sourceMessageId is omitted', async () => {
    const source = await fixture.source();
    const response = await fixture.propose(source);
    assert.equal(response.statusCode, 200, response.body);
    const proposal = fixture.store.get(response.json().proposalId);
    assert.equal(proposal.sourceMessageId, source.id);
    assert.deepEqual(proposal.approvalOriginRef, { kind: 'message', threadId: 'thread_1', messageId: source.id });
    assert.deepEqual(proposal.publication.envelope.originRef, proposal.approvalOriginRef);
  });

  it('refuses withdrawn, foreign-owner and foreign-thread origins without reserving the key', async () => {
    const withdrawn = await fixture.source();
    await fixture.messages.softDelete(withdrawn.id, 'alice');
    const sources = [
      withdrawn,
      await fixture.source({ userId: 'bob' }),
      await fixture.source({ threadId: 'thread_2' }),
    ];
    for (const source of sources) {
      const response = await fixture.propose(source);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error, 'origin_not_eligible');
      assert.equal(fixture.store.getDedupProposalId('alice', tasteDraft.clientRequestId), null);
    }
    assert.deepEqual(fixture.store.listPending('alice'), []);
  });

  it('refuses a changed payload under the same key, including a public visibility change', async () => {
    const source = await fixture.source();
    const original = await fixture.propose(source);
    assert.equal(original.statusCode, 200, original.body);
    const changes = [
      { scene: 'Different scene' },
      { quote: 'Different quote' },
      { takeaway: 'Different interpretation' },
      { tags: ['other'] },
      { dimension: 'creative-craft' },
      { privacy: 'public' },
    ];
    for (const change of changes) {
      const response = await fixture.propose(source, { ...tasteDraft, ...change });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error, 'client_request_conflict');
    }
    assert.equal(fixture.store.listPending('alice').length, 1);
    assert.equal(fixture.store.get(original.json().proposalId).privacy, 'sensitive');
  });

  it('refuses another cat or thread reusing the key instead of returning its original proposal', async () => {
    const source = await fixture.source();
    await fixture.propose(source);
    const otherThreadSource = await fixture.source({ threadId: 'thread_2' });
    for (const [origin, scope] of [
      [source, { catId: 'sonnet' }],
      [otherThreadSource, { threadId: 'thread_2' }],
    ]) {
      const response = await fixture.propose(origin, tasteDraft, scope);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error, 'client_request_conflict');
      assert.equal(response.json().proposalId, undefined);
    }
  });

  it('recovers the original source from a later invocation, then rejects its withdrawal', async () => {
    const source = await fixture.source();
    const first = await fixture.propose(source);
    const later = await fixture.source({ content: 'Please retry the previous request' });
    const retry = await fixture.propose(later);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().proposalId, first.json().proposalId);
    const original = fixture.store.get(first.json().proposalId);
    assert.equal(original.approvalOriginRef.messageId, source.id);
    await fixture.messages.softDelete(source.id, 'alice');
    const revoked = await fixture.propose(later);
    assert.equal(revoked.statusCode, 409, revoked.body);
    assert.equal(revoked.json().error, 'origin_not_eligible');
  });

  it('checks the current caller origin even when its request already has a cached result', async () => {
    const source = await fixture.source();
    await fixture.propose(source);
    const later = await fixture.source();
    await fixture.messages.softDelete(later.id, 'alice');
    const response = await fixture.propose(later);
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'origin_not_eligible');
  });

  for (const staged of [false, true]) {
    it(`recovers an unchanged explicit source from a later invocation (${staged ? 'staged' : 'anchored'})`, async () => {
      const source = await fixture.source();
      const input = { ...tasteDraft, sourceMessageId: source.id };
      const commit = fixture.store.commitEnvelope.bind(fixture.store);
      if (staged)
        fixture.store.commitEnvelope = async () => {
          throw new Error('Interrupted after original card');
        };
      const first = await fixture.propose(source, input);
      assert.equal(first.statusCode, staged ? 500 : 200, first.body);
      fixture.store.commitEnvelope = commit;
      const savedId = fixture.store.getDedupProposalId('alice', input.clientRequestId);
      const later = await fixture.source({ content: 'Continue the exact earlier request' });
      const retry = await fixture.propose(later, input);
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json().proposalId, savedId);
      assert.equal(fixture.store.get(savedId).publication.envelope.originRef.messageId, source.id);
      const changed = await fixture.propose(later, { ...input, sourceMessageId: later.id });
      assert.equal(changed.statusCode, 409, changed.body);
      assert.equal(changed.json().error, 'client_request_conflict');
      await fixture.messages.softDelete(later.id, 'alice');
      const invalidCaller = await fixture.propose(later, input);
      assert.equal(invalidCaller.statusCode, 409, invalidCaller.body);
      assert.equal(invalidCaller.json().error, 'origin_not_eligible');
      await fixture.messages.softDelete(source.id, 'alice');
      const freshCaller = await fixture.source();
      const withdrawn = await fixture.propose(freshCaller, input);
      assert.equal(withdrawn.statusCode, 409, withdrawn.body);
      assert.equal(withdrawn.json().error, 'origin_not_eligible');
    });
  }

  it('keeps original provenance through a failed envelope commit and a later invocation', async () => {
    const source = await fixture.source();
    const commit = fixture.store.commitEnvelope.bind(fixture.store);
    let fail = true;
    fixture.store.commitEnvelope = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('lost envelope commit');
      }
      return commit(...args);
    };
    const first = await fixture.propose(source);
    assert.equal(first.statusCode, 500, first.body);
    const [staged] = fixture.store.listPending('alice');
    assert.equal(staged.publication.state, 'staged');
    const later = await fixture.source();
    const retry = await fixture.propose(later);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().proposalId, staged.id);
    assert.equal(fixture.store.get(staged.id).publication.envelope.originRef.messageId, source.id);
  });

  it('checks payload identity in the reservation-loser path as well as the initial cache read', async () => {
    const source = await fixture.source();
    await fixture.propose(source);
    // Another request committed between this request's cache read and reservation.
    const getDedup = fixture.store.getDedupProposalId.bind(fixture.store);
    let firstRead = true;
    fixture.store.getDedupProposalId = (...args) => {
      if (firstRead) {
        firstRead = false;
        return null;
      }
      return getDedup(...args);
    };
    const response = await fixture.propose(source, { ...tasteDraft, quote: 'Conflicting concurrent request' });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'client_request_conflict');
    assert.equal(fixture.store.listPending('alice').length, 1);
  });

  it('does not republish a legacy proposal with no verifiable original message', async () => {
    const proposalId = 'taste-legacy-event';
    fixture.store.reserveDedup('alice', tasteDraft.clientRequestId, proposalId);
    fixture.store.create({
      ...tasteDraft,
      proposalId,
      userId: 'alice',
      catId: 'opus',
      threadId: 'thread_1',
      approvalOriginRef: { kind: 'event', anchor: 'invocation:legacy', summary: 'Legacy event' },
    });
    const response = await fixture.propose(await fixture.source());
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'origin_not_eligible');
    assert.equal(fixture.store.get(proposalId).publication.state, 'staged');
  });
});
