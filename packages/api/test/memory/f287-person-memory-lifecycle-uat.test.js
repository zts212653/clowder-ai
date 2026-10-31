import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function happyFetch(fixture, calls) {
  let recallCount = 0;
  const recall = () => {
    recallCount += 1;
    if (recallCount === 3) return json({ status: 'not_available' });
    const corrected = recallCount === 2;
    return json({
      status: 'resolved',
      card: {
        personId: 'person_f287_alpha',
        displayName: fixture.displayName,
        relationshipLine: '当前关系',
        facts: [
          {
            claimId: corrected ? 'person_claim_corrected' : 'person_claim_initial',
            text: corrected ? fixture.correctedFactValue : fixture.initialFactValue,
          },
        ],
        latestInteraction: {
          eventId: 'person_event_alpha',
          headline: fixture.interactionHeadline,
        },
      },
    });
  };
  const routes = new Map([
    [
      '/api/callbacks/thread-context',
      () =>
        json({
          threadId: 'thread-alpha-f287',
          messages: [
            {
              id: 'message-alpha-source',
              speaker: 'You',
              content: `${fixture.sourceText}\nRun the alpha-only harness now.`,
            },
          ],
        }),
    ],
    [
      '/api/callbacks/propose-person-memory',
      () =>
        json({
          candidateId: 'person_candidate_f287_alpha',
          status: 'pending_approval',
          messageId: 'message-alpha-card',
        }),
    ],
    [
      '/api/callbacks/person-memory/proposals/person_candidate_f287_alpha/status',
      () =>
        json({
          proposalId: 'person_candidate_f287_alpha',
          status: 'pending_approval',
          publicationState: 'anchored',
          remainingDraftIds: [
            'person_draft_f287:claim',
            'person_draft_f287:relationship',
            'person_draft_f287:interaction',
          ],
        }),
    ],
    [
      '/api/person-memory-proposals/person_candidate_f287_alpha/approve',
      ({ body }) =>
        json({
          proposalId: 'person_candidate_f287_alpha',
          status: 'materialized',
          personId: 'person_f287_alpha',
          selectedDraftIds: body.selectedDraftIds,
          materializedClaimIds: ['person_claim_initial'],
          materializedRelationshipIds: ['person_relationship_alpha'],
          materializedEventIds: ['person_event_alpha'],
        }),
    ],
    ['/api/callbacks/person-memory/recall', recall],
    [
      '/api/callbacks/person-memory/correct-claim',
      () => json({ outcome: 'applied', claim: { claimId: 'person_claim_corrected' } }),
    ],
    ['/api/callbacks/person-memory/forget', () => json({ verdict: 'purged', purgedSurfaceCounts: { people: 1 } })],
  ]);
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const call = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.search,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };
    calls.push(call);
    const handler = routes.get(url.pathname);
    return handler ? handler(call) : json({ error: 'unexpected_test_route' }, 500);
  };
}

describe('F287 person-memory lifecycle alpha UAT harness', () => {
  test('keeps the real three-surface owner fixture inside the approval-card budget', async () => {
    const { buildF287AlphaOwnerFixture, buildF287PersonMemoryProposalBody } = await import(
      '../../dist/scripts/f287-person-memory-lifecycle-uat.js'
    );
    const { assertionTargets, candidateIdForProposal, makeCandidateInput, previewCandidateForProposal } = await import(
      '../../dist/routes/person-memory-proposal-candidate.js'
    );
    const { preflightPersonMemoryProposalCard } = await import('../../dist/routes/person-memory-proposal-preflight.js');
    const auth = {
      invocationId: 'invocation-alpha',
      userId: 'owner-alpha',
      catId: 'codex-sol',
      threadId: 'thread-alpha-f287',
    };
    for (const runId of [
      'f287b4_9628abd_02',
      'f287b4_9628abd_03',
      'f287b4_max_length_012345678901234567890123456789',
    ]) {
      const fixture = buildF287AlphaOwnerFixture(runId);
      const parsed = buildF287PersonMemoryProposalBody(fixture, 'message-alpha-source', runId);
      const candidateId = candidateIdForProposal(parsed, auth);
      const targets = assertionTargets(candidateId, parsed);
      const sourceId = 'f287-alpha-owner-source';
      const sourceBundle = {
        sources: [
          {
            sourceId,
            kind: 'message_text',
            sourceRef: { kind: 'message', threadId: auth.threadId, messageId: 'message-alpha-source' },
            ownerUserId: auth.userId,
            resolvedDigest: 'a'.repeat(64),
            excerpt: fixture.proposalEvidenceText,
          },
        ],
        assertionBindings: [
          {
            sourceId,
            target: { kind: 'claim', draftId: targets.claimDraftIds[0] },
            role: 'reported_fact',
          },
          {
            sourceId,
            target: { kind: 'relationship', draftId: targets.relationshipDraftId, field: 'status' },
            role: 'reported_fact',
          },
          {
            sourceId,
            target: { kind: 'interaction', draftId: targets.interactionDraftId, field: 'eventKind' },
            role: 'reported_fact',
          },
          {
            sourceId,
            target: { kind: 'interaction', draftId: targets.interactionDraftId, field: 'headline' },
            role: 'reported_fact',
          },
          {
            sourceId,
            target: {
              kind: 'interaction',
              draftId: targets.interactionDraftId,
              field: 'importanceOrTopic',
            },
            role: 'user_assessment',
          },
        ],
      };
      const candidate = previewCandidateForProposal(
        makeCandidateInput(parsed, auth, 'message-alpha-source', [], sourceBundle),
      );

      const preflight = preflightPersonMemoryProposalCard(candidate);

      assert.equal(preflight.status, 'ready', `${runId}: ${JSON.stringify(preflight)}`);
      assert.ok(preflight.estimatedTokens <= 236, `${runId}: expected at least four tokens of headroom`);
    }
  });

  test('orchestrates authenticated propose, approve, recall, correct and forget with content-free evidence', async () => {
    const { buildF287AlphaOwnerFixture, runF287PersonMemoryLifecycleUat } = await import(
      '../../dist/scripts/f287-person-memory-lifecycle-uat.js'
    );
    const { proposePersonMemorySchema } = await import('../../dist/routes/person-memory-proposal-source-contract.js');
    const runId = 'f287b4_9628abd_01';
    const fixture = buildF287AlphaOwnerFixture(runId);
    const calls = [];
    const fetchImpl = happyFetch(fixture, calls);

    const result = await runF287PersonMemoryLifecycleUat({
      baseUrl: 'http://127.0.0.1:3012',
      invocationId: 'invocation-alpha',
      callbackToken: 'callback-secret',
      ownerUserId: 'owner-alpha',
      runId,
      fetchImpl,
    });

    assert.deepEqual(result, {
      fixtureRevision: 'f287-person-memory-lifecycle-v4',
      environment: 'alpha',
      proposalId: 'person_candidate_f287_alpha',
      personId: 'person_f287_alpha',
      statuses: {
        proposal: 'pending_approval',
        approval: 'materialized',
        firstRecall: 'resolved',
        correction: 'applied',
        updatedRecall: 'resolved',
        forget: 'purged',
        finalRecall: 'not_available',
      },
      selectedDraftCount: 3,
      materialized: { claimCount: 1, relationshipCount: 1, eventCount: 1 },
      assertions: {
        identityPresent: true,
        relationshipPresent: true,
        interactionPresent: true,
        correctionReplacedClaim: true,
        finalForgetZero: true,
        historicalRejectedAldenCounted: false,
      },
    });
    const serialized = JSON.stringify(result);
    for (const secret of [
      fixture.marker,
      fixture.displayName,
      fixture.initialFactValue,
      fixture.correctedFactValue,
      fixture.interactionHeadline,
      'callback-secret',
      'owner-alpha',
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.equal(calls[0].query, '?responseMode=full&limit=20');
    assert.equal(calls[1].body.sourceMessageId, 'message-alpha-source');
    const proposalParse = proposePersonMemorySchema.safeParse(calls[1].body);
    assert.equal(
      proposalParse.success,
      true,
      proposalParse.success ? undefined : JSON.stringify(proposalParse.error.issues),
    );
    assert.ok(calls[1].body.sourceBundle, 'proposal must use the native typed source bundle');
    assert.deepEqual(calls[1].body.sourceBundle.assertionBindings, [
      {
        sourceId: 'f287-alpha-owner-source',
        target: { kind: 'claim', index: 0 },
        role: 'reported_fact',
      },
      {
        sourceId: 'f287-alpha-owner-source',
        target: { kind: 'relationship', field: 'status' },
        role: 'reported_fact',
      },
      {
        sourceId: 'f287-alpha-owner-source',
        target: { kind: 'interaction', field: 'eventKind' },
        role: 'reported_fact',
      },
      {
        sourceId: 'f287-alpha-owner-source',
        target: { kind: 'interaction', field: 'headline' },
        role: 'reported_fact',
      },
      {
        sourceId: 'f287-alpha-owner-source',
        target: { kind: 'interaction', field: 'importanceOrTopic' },
        role: 'user_assessment',
      },
    ]);
    assert.deepEqual(calls[3].body.selectedDraftIds, [
      'person_draft_f287:claim',
      'person_draft_f287:relationship',
      'person_draft_f287:interaction',
    ]);
    assert.equal(calls[3].headers['x-cat-cafe-user'], 'owner-alpha');
    for (const call of calls.filter((item) => item.path.startsWith('/api/callbacks/'))) {
      assert.equal(call.headers['x-invocation-id'], 'invocation-alpha');
      assert.equal(call.headers['x-callback-token'], 'callback-secret');
    }
  });

  test('refuses non-alpha API origins before any network request', async () => {
    const { runF287PersonMemoryLifecycleUat } = await import('../../dist/scripts/f287-person-memory-lifecycle-uat.js');
    let called = false;
    await assert.rejects(
      runF287PersonMemoryLifecycleUat({
        baseUrl: 'http://127.0.0.1:3004',
        invocationId: 'invocation-runtime',
        callbackToken: 'callback-runtime',
        ownerUserId: 'owner-runtime',
        runId: 'blocked-runtime',
        fetchImpl: async () => {
          called = true;
          return json({});
        },
      }),
      /alpha API origin must be http:\/\/\(127\.0\.0\.1\|localhost\):3012/,
    );
    assert.equal(called, false);
  });

  test('does not echo private response bodies or callback credentials on HTTP failure', async () => {
    const { buildF287AlphaOwnerFixture, runF287PersonMemoryLifecycleUat } = await import(
      '../../dist/scripts/f287-person-memory-lifecycle-uat.js'
    );
    const fixture = buildF287AlphaOwnerFixture('run-private-error');
    let calls = 0;
    await assert.rejects(
      runF287PersonMemoryLifecycleUat({
        baseUrl: 'http://localhost:3012',
        invocationId: 'invocation-alpha',
        callbackToken: 'callback-private',
        ownerUserId: 'owner-alpha',
        runId: 'run-private-error',
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) {
            return json({ messages: [{ id: 'message-source', content: fixture.sourceText }] });
          }
          return json({ error: 'source_rejected', privateText: fixture.initialFactValue }, 422);
        },
      }),
      (error) => {
        assert.match(error.message, /propose failed with HTTP 422: source_rejected/);
        assert.equal(error.message.includes(fixture.initialFactValue), false);
        assert.equal(error.message.includes('callback-private'), false);
        return true;
      },
    );
  });
});
