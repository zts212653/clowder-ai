import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceContentReviewError } from '../src/domains/collaborative-content/workspace-review/errors.js';
import { baseConstraint, digest, fixture, scope, text } from './collective-markdown.fixture.js';

// These owner boundary tests consume Service-issued constraints; HTTP tests exercise their actual issuer.
for (const failure of ['none', 'owner-denied', 'lost-commit-response', 'competing-human']) {
  test(`a shared annotation request adopts once and recovers ${failure}`, async (t) => {
    const f = await fixture(t);
    const feedback = await f.execute(
      { ...baseConstraint, action: 'annotate' },
      {
        kind: 'annotate',
        messageEventId: 'event-comment',
        body: 'Please make it clearer.',
        quote: 'A unique shared quote.',
        location: { channelId: 'general', rootEventId: scope.sourceEventId },
        expectedReviewRevision: 1,
      },
      'annotate-first',
    );
    if (feedback.status !== 'ok') throw new Error(JSON.stringify(feedback));
    const review = feedback.value.view.review;
    const requested = await f.execute(
      { ...baseConstraint, action: 'propose' },
      {
        kind: 'request-modification',
        messageEventId: 'event-ask-cat',
        annotationIds: [review.annotations[0].id],
        expectedReviewRevision: review.revision,
        instruction: 'Please improve this phrase.',
        location: { channelId: 'general', rootEventId: scope.sourceEventId },
        target: {
          humanId: 'human-bob',
          catId: 'codex61-sol',
          connectionId: 'connection-bob',
          participationRevision: 1,
        },
      },
      'ask-cat',
    );
    assert.equal(requested.status, 'ok', f.errors.map(String).join('\n'));
    if (requested.status !== 'ok') return;
    const request = requested.value.request;
    const agent = {
      requestEventId: 'event-ask-cat',
      catId: 'codex61-sol',
      humanId: 'human-bob',
      connectionId: 'connection-bob',
      participationRevision: 1,
      membershipRevision: 1,
      revocationEpoch: 1,
    };
    const command = {
      kind: 'respond-modification',
      requestId: request.requestId,
      operationId: '00000000-0000-4000-8000-000000000001',
      expectedOwnerRevision: 1,
      expectedProposalRevision: 0,
      baseRevision: digest,
      edits: [
        {
          start: text.indexOf('unique'),
          end: text.indexOf('unique') + 6,
          expectedText: 'unique',
          replacement: 'clear',
        },
      ],
      response: 'Clarified this phrase.',
    };
    const spoof = await f.execute({ ...baseConstraint, action: 'propose' }, command, 'fake-cat-response');
    assert.equal(spoof.status, 'error');
    const submitted = await f.execute({ ...baseConstraint, action: 'propose', agent }, command, 'cat-response');
    assert.equal(submitted.status, 'ok', f.errors.map(String).join('\n'));
    if (submitted.status !== 'ok') return;
    const selected = { requestId: request.requestId, proposalRef: submitted.value.proposal.proposalRef };
    const preview = await f.execute({ ...baseConstraint, action: 'preview' }, selected, 'compare-cat-change');
    assert.equal(preview.status, 'ok', f.errors.map(String).join('\n'));
    assert.equal((await f.owner.describe(scope.contentRef)).currentOwnerRevision, 1);
    const settle = f.owner.settle.bind(f.owner);
    if (failure === 'owner-denied') {
      f.owner.settle = (input) =>
        settle({
          ...input,
          authorizeEffect: async () => {
            await input.authorizeEffect?.();
            throw new WorkspaceContentReviewError('access_denied');
          },
        });
      const denied = await f.execute(
        { ...baseConstraint, humanId: 'human-bob', action: 'apply' },
        selected,
        'denied-adoption',
      );
      assert.deepEqual(denied, { status: 'error', error: { code: 'access_denied' } });
      assert.equal((await f.owner.describe(scope.contentRef)).currentOwnerRevision, 1);
      f.owner.settle = settle;
    }
    if (failure === 'lost-commit-response') {
      let lost = false;
      f.owner.settle = async (input) => {
        const receipt = await settle(input);
        if (!lost) {
          lost = true;
          throw new Error('simulated response loss after atomic owner commit');
        }
        return receipt;
      };
    }
    const attempts = [
      { constraint: { ...baseConstraint, action: 'apply' as const }, id: 'adopt-cat-change' },
      {
        constraint: {
          ...baseConstraint,
          action: 'apply' as const,
          humanId: failure === 'competing-human' ? 'human-bob' : baseConstraint.humanId,
        },
        id: failure === 'competing-human' ? 'other-adoption' : 'adopt-cat-change',
      },
    ];
    const results = await Promise.all(attempts.map((attempt) => f.execute(attempt.constraint, selected, attempt.id)));
    const winnerIndex = results.findIndex((result) => result.status === 'ok');
    const winner = attempts[winnerIndex];
    const adopted = results[winnerIndex];
    if (failure === 'competing-human') assert.equal(results.filter((result) => result.status === 'ok').length, 1);
    else assert.deepEqual(results[0], results[1]);
    assert.ok(adopted && winner, f.errors.map(String).join('\n'));
    assert.equal(adopted.status, 'ok', f.errors.map(String).join('\n'));
    if (adopted.status !== 'ok') return;
    assert.equal(adopted.value.receipt.ownerRevision, 2);
    assert.equal((await f.owner.load(scope.contentRef)).bytes.toString('utf8'), text.replace('unique', 'clear'));
    const replay = await f.execute(winner.constraint, selected, winner.id);
    assert.deepEqual(replay, adopted);
    assert.equal((await f.owner.listOutbox(scope.contentRef)).length, 2);
    const current = { ...baseConstraint, ownerRevision: 2, blobDigest: adopted.value.receipt.blobDigest };
    const readers = await Promise.all([
      f.execute(current, {}, 'alice-read-adopted'),
      f.execute({ ...current, humanId: 'human-bob' }, {}, 'bob-read-adopted'),
    ]);
    assert.equal(
      readers.every((result) => result.status === 'ok'),
      true,
      f.errors.map(String).join('\n'),
    );

    assert.equal(f.modifications.text.source(request.requestId), null);
    for (const result of [requested, submitted, preview, adopted])
      assert.equal(JSON.stringify(result).includes('real-local-owner'), false);
  });
}
