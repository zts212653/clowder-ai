/**
 * F290 communication — L1 validation: two real Connectors (two Cafés) against one real Service.
 * See f290-communication-validation.harness.ts for exactly which parts are production and which are fixtures.
 *
 * Acceptance goes through the production Connector wrapper only: owner registration on the Service (Human session),
 * strict local adoption on the Host (`adoptWorkPolicy`), and `acceptWork` under the production verifier. Nothing here
 * reads a private endpoint credential. Regression expectations always run; repaired cases have no todo bypass.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectiveEventSourceIdentity } from '@cat-cafe/shared';
import {
  acceptNaturally,
  CHANNEL,
  catAccepts,
  createWorld,
  grantAndAdopt,
  inFlightWork,
  landyRequestsRevision,
  ownerPolicy,
  postNaturalRequest,
  returnResult,
  type World,
  workOf,
} from './f290-communication-validation.harness.js';

async function withWorld(run: (world: World) => Promise<void>) {
  const world = await createWorld();
  try {
    await run(world);
  } finally {
    await world.close();
  }
}

async function events(world: World) {
  return world.store.listEventsForHuman(world.operator.sessionToken, world.coordinates.collectiveId);
}

/** Error code from a Service refusal surfaced through the Connector (transport cause) or thrown locally. */
function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; causeCode?: unknown };
  return typeof candidate.causeCode === 'string'
    ? candidate.causeCode
    : typeof candidate.code === 'string'
      ? candidate.code
      : undefined;
}
const refusedWith =
  (...codes: string[]) =>
  (error: unknown) => {
    assert.ok(
      codes.includes(codeOf(error) ?? ''),
      `expected one of ${codes.join('|')}, got ${codeOf(error)}: ${(error as Error)?.message}`,
    );
    return true;
  };

test('registering an owner policy keeps the Connector online: the participation receipt still equals the declaration', async () => {
  await withWorld(async (world) => {
    const { operator, wulang } = world;
    const revision = await world.declareCats(operator, ['codex-sol']);
    await world.declareCats(wulang, ['codex-sol']);
    const before = await operator.connector.sync(operator.connectionId);
    assert.equal(before.liveStatus, 'online', 'control: online before any owner policy exists');
    await grantAndAdopt(world, operator);
    const request = await postNaturalRequest(world, wulang, operator, 'codex-sol', 'Write the guide.', revision);
    const accepted = await catAccepts(world, operator, request);
    const after = await operator.connector.sync(operator.connectionId);
    assert.equal(after.lastError, undefined);
    assert.equal(after.liveStatus, 'online');
    const inbox = await operator.connector.listInbox(operator.connectionId);
    assert.ok(
      inbox.some((item) => item.event.eventId === accepted.assignmentEventId),
      'the assignment is durably delivered to the accepting Café',
    );
  });
});

test('natural acceptance across two Cafés: one Work, accountable Human derived from the connection, replay- and restart-safe', async () => {
  await withWorld(async (world) => {
    const { operator, wulang } = world;
    const landyRevision = await world.declareCats(operator, ['codex-sol']);
    await world.declareCats(wulang, ['codex-sol', 'codex-terra']);
    const request = await postNaturalRequest(
      world,
      wulang,
      operator,
      'codex-sol',
      'Please write a newcomer guide and return it here.',
      landyRevision,
    );
    await grantAndAdopt(world, operator);
    const accepted = await catAccepts(world, operator, request);

    // accountable Human is derived from the accepting connection (You), not from the requester (Wulang)
    assert.equal(accepted.accountableHumanId, operator.humanId);
    assert.notEqual(accepted.accountableHumanId, wulang.humanId);
    assert.equal(accepted.assignment?.connectionId, operator.connectionId);
    assert.equal(accepted.proposedBy.kind, 'agent');
    assert.equal(accepted.lifecycle, 'committed');
    assert.equal(accepted.acceptance?.sourceEventId, request.eventId);
    assert.equal(accepted.acceptance?.grantRef, 'grant-guides');
    assert.equal(accepted.acceptance?.hostAdmission, undefined, 'acceptance is not Host admission');

    const assignment = (await events(world)).find((event) => event.eventId === accepted.assignmentEventId);
    assert.ok(assignment, 'assignment event exists in the ordered log');
    assert.equal(assignment.actor.kind, 'agent', 'no Human click is forged');
    assert.equal(assignment.workRequest, 'entrust');
    assert.equal(assignment.replyToEventId, request.eventId);
    assert.equal(assignment.recipient?.kind === 'agent' && assignment.recipient.connectionId, operator.connectionId);
    assert.equal(assignment.workAcceptanceNotice?.workId, accepted.workId);

    // replay (lost response), Service restart and Connector restart are all the same acceptance
    assert.equal((await catAccepts(world, operator, request)).workId, accepted.workId);
    await world.restartService();
    assert.equal((await catAccepts(world, operator, request)).workId, accepted.workId);
    await world.restartConnector(operator);
    assert.equal((await catAccepts(world, operator, request)).workId, accepted.workId);
    await world.syncAll();
    const inbox = await operator.connector.listInbox(operator.connectionId);
    assert.equal(
      inbox.filter((item) => item.event.eventId === accepted.assignmentEventId).length,
      1,
      'one durable inbox item for the one assignment',
    );
    assert.equal(
      world.store.listCollectiveCollaboration(operator.sessionToken, world.coordinates.collectiveId).works.length,
      1,
    );
    assert.equal((await events(world)).filter((event) => event.workRequest === 'entrust').length, 1);
  });
});

test('both halves must hold: a Service registration the Host has not adopted cannot accept, and a Service contraction the Host has not seen still blocks', async () => {
  await withWorld(async (world) => {
    const { operator, wulang } = world;
    const revision = await world.declareCats(operator, ['codex-sol']);
    await world.declareCats(wulang, ['codex-sol']);
    const request = await postNaturalRequest(world, wulang, operator, 'codex-sol', 'Write the guide.', revision);
    // registered by the owner on the Service, but the Host never adopted it
    const policy = await world.store.registerCollectiveWorkPolicy(operator.sessionToken, ownerPolicy(world, operator));
    await assert.rejects(
      catAccepts(world, operator, request, { grantRevision: 1 }),
      refusedWith('WORK_DELEGATION_UNAVAILABLE'),
    );
    await operator.connector.adoptWorkPolicy(operator.connectionId, operator.ownerUserId, policy.revision);
    // adoption is by the local owner only
    await assert.rejects(
      operator.connector.adoptWorkPolicy(operator.connectionId, 'someone-else', policy.revision),
      refusedWith('CONNECTOR_OWNER_MISMATCH'),
    );
    // the owner narrows the registration on the Service; the Host's adopted copy is now stale
    await world.store.registerCollectiveWorkPolicy(
      operator.sessionToken,
      ownerPolicy(world, operator, { expectedRevision: policy.revision, requestId: 'owner-narrows', grants: [] }),
    );
    await assert.rejects(catAccepts(world, operator, request), refusedWith('WORK_DELEGATION_UNAVAILABLE'));
    assert.equal(
      world.store.listCollectiveCollaboration(operator.sessionToken, world.coordinates.collectiveId).works.length,
      0,
    );
  });
});

test('S4 owner exceptions: manual mode asks, allow-once covers only that request, standing rule stays inside its scope', async () => {
  await withWorld(async (world) => {
    const { operator, wulang } = world;
    const revision = await world.declareCats(operator, ['codex-sol']);
    await world.declareCats(wulang, ['codex-sol']);
    const first = await postNaturalRequest(world, wulang, operator, 'codex-sol', 'First guide request', revision);
    const second = await postNaturalRequest(world, wulang, operator, 'codex-sol', 'Second guide request', revision);
    const grant = {
      grantRef: 'grant-guides',
      catIds: ['codex-sol'],
      channelIds: [CHANNEL],
      requestingHumanIds: 'channel_members',
      requestKinds: ['guide'],
      expiresAt: null,
    };
    // manual mode: a standing grant does not let the Cat decide alone
    const manual = await world.store.registerCollectiveWorkPolicy(operator.sessionToken, {
      ...ownerPolicy(world, operator, { grants: [grant] }),
      decisionMode: 'manual',
    });
    await operator.connector.adoptWorkPolicy(operator.connectionId, operator.ownerUserId, manual.revision);
    const sourceOf = (event: typeof first) => {
      const source = collectiveEventSourceIdentity(event);
      assert.ok(source);
      return source;
    };
    const decision = await operator.connector.currentWorkDecision(sourceOf(first));
    assert.equal(decision.decisionMode, 'manual');
    assert.equal(decision.delegationState, 'adopted');
    await assert.rejects(catAccepts(world, operator, first), refusedWith('WORK_OWNER_DECISION_REQUIRED'));

    // "allow this once": a grant naming exactly the first request
    const once = await world.store.registerCollectiveWorkPolicy(operator.sessionToken, {
      ...ownerPolicy(world, operator, {
        expectedRevision: manual.revision,
        requestId: 'allow-once',
        grants: [grant, { ...grant, grantRef: 'grant-once', sourceEventIds: [first.eventId] }],
      }),
      decisionMode: 'manual',
    });
    await operator.connector.adoptWorkPolicy(operator.connectionId, operator.ownerUserId, once.revision);
    const onceDecision = await operator.connector.currentWorkDecision(sourceOf(first));
    assert.deepEqual(
      onceDecision.grants.filter((candidate) => candidate.allowedOnce).map((candidate) => candidate.grantRef),
      ['grant-once'],
    );
    assert.deepEqual(
      (await operator.connector.currentWorkDecision(sourceOf(second))).grants.filter(
        (candidate) => candidate.allowedOnce,
      ),
      [],
      'the one-time permission is not visible for another request',
    );
    const onceGrant = once.grants.find((candidate) => candidate.grantRef === 'grant-once');
    assert.ok(onceGrant);
    const accepted = await catAccepts(world, operator, first, {
      grantRef: 'grant-once',
      grantRevision: onceGrant.grantRevision,
    });
    assert.ok(accepted.workId);
    await assert.rejects(
      catAccepts(world, operator, second, { grantRef: 'grant-once', grantRevision: onceGrant.grantRevision }),
      refusedWith('WORK_DELEGATION_UNAVAILABLE'),
      'allow-once never becomes a standing permission',
    );
    await assert.rejects(catAccepts(world, operator, second), refusedWith('WORK_OWNER_DECISION_REQUIRED'));

    // "allow similar from now on": automatic, inside catIds/channelIds/requestKinds only
    const always = await world.store.registerCollectiveWorkPolicy(operator.sessionToken, {
      ...ownerPolicy(world, operator, { expectedRevision: once.revision, requestId: 'allow-similar', grants: [grant] }),
      decisionMode: 'automatic',
    });
    await operator.connector.adoptWorkPolicy(operator.connectionId, operator.ownerUserId, always.revision);
    const alwaysGrant = always.grants.find((candidate) => candidate.grantRef === 'grant-guides');
    assert.ok(alwaysGrant);
    await assert.rejects(
      catAccepts(world, operator, second, { grantRevision: alwaysGrant.grantRevision, requestKind: 'code' }),
      refusedWith('WORK_DELEGATION_UNAVAILABLE'),
      'a different kind of work is outside the rule',
    );
    const similar = await catAccepts(world, operator, second, { grantRevision: alwaysGrant.grantRevision });
    assert.notEqual(similar.workId, accepted.workId);
  });
});

test('same catId in two Cafés never crosses: no borrowed grant, no accepting another Café’s request', async () => {
  await withWorld(async (world) => {
    const { operator, wulang } = world;
    const landyRevision = await world.declareCats(operator, ['codex-sol']);
    const wulangRevision = await world.declareCats(wulang, ['codex-sol']);
    await grantAndAdopt(world, operator);
    const toYou = await postNaturalRequest(world, wulang, operator, 'codex-sol', 'Guide for You Café', landyRevision);

    // Wulang's Connector cannot accept a request addressed to You's Cat, whatever the catId says
    await assert.rejects(catAccepts(world, wulang, toYou, { grantRevision: 1 }), refusedWith('PARTICIPATION_REVOKED'));
    const toWulang = await postNaturalRequest(world, operator, wulang, 'codex-sol', 'Guide for Wulang', wulangRevision);
    // Wulang's own Café has no owner policy: You's grantRef does not travel with the catId
    await assert.rejects(
      catAccepts(world, wulang, toWulang, { grantRevision: 1 }),
      refusedWith('WORK_DELEGATION_UNAVAILABLE'),
    );
    // Wulang cannot register or adopt a delegation for You's connection
    await assert.rejects(
      world.store.registerCollectiveWorkPolicy(
        wulang.sessionToken,
        ownerPolicy(world, operator, { requestId: 'wulang-widens-operator', expectedRevision: 1 }),
      ),
      { code: 'WORK_DELEGATION_OWNER_REQUIRED' },
    );
    assert.equal(
      world.store.listCollectiveCollaboration(operator.sessionToken, world.coordinates.collectiveId).works.length,
      0,
    );
  });
});

test('Host revocation blocks locally at once (even offline), is confirmed to the Service later, keeps the committed matter and refuses its late result', async () => {
  await withWorld(async (world) => {
    const { operator } = world;
    const { accepted, source } = await inFlightWork(world);
    await world.stopService();
    await operator.connector
      .revokeWorkGrants(operator.connectionId, operator.ownerUserId, ['grant-guides'])
      .catch(() => undefined);
    // the contraction is durable locally before any network IO
    await world.startService();
    const confirmed = await operator.connector.sync(operator.connectionId);
    assert.equal(confirmed.liveStatus, 'online');
    const policy = await operator.connector.readWorkPolicy(operator.connectionId);
    assert.equal(policy?.grants.find((grant) => grant.grantRef === 'grant-guides')?.status, 'revoked');
    // the committed matter is history, not erased
    assert.equal(workOf(world, accepted.workId).lifecycle, 'committed');
    // a result produced after revocation is refused by the Service; the Work does not silently advance
    await returnResult(world, source, 'guide', 1, 'Guide v1').catch(() => undefined);
    await operator.connector.sync(operator.connectionId).catch(() => undefined);
    const work = workOf(world, accepted.workId);
    assert.equal(work.lifecycle, 'committed', 'a revoked delegation cannot return a result');
    assert.equal(work.resultEventId, undefined);
  });
});

test('an accepted Work without an actual Host admission receipt cannot return a result; a Host refusal keeps it that way', async () => {
  await withWorld(async (world) => {
    const { operator, wulang } = world;
    const revision = await world.declareCats(operator, ['codex-sol']);
    await world.declareCats(wulang, ['codex-sol']);
    await grantAndAdopt(world, operator);
    const request = await postNaturalRequest(world, wulang, operator, 'codex-sol', 'Write the guide.', revision);
    const { accepted, source } = await acceptNaturally(world, request, { admit: false });
    await returnResult(world, source, 'guide', 1, 'Guide v1').catch(() => undefined);
    await operator.connector.sync(operator.connectionId).catch(() => undefined);
    assert.equal(workOf(world, accepted.workId).lifecycle, 'committed', 'acceptance alone is not execution authority');
    // a Host refusal is a fact too, and it does not unlock execution
    assert.ok(accepted.acceptance);
    await operator.connector.recordHostAdmission(operator.connectionId, {
      workId: accepted.workId,
      assignmentEventId: accepted.assignmentEventId as string,
      operationRef: accepted.acceptance.operationRef,
      grantRef: accepted.acceptance.grantRef,
      grantRevision: accepted.acceptance.grantRevision,
      disposition: { state: 'rejected', receiptRef: 'host-admission:refusal', reason: 'WORK_DELEGATION_UNAVAILABLE' },
    });
    await operator.connector.sync(operator.connectionId).catch(() => undefined);
    const work = workOf(world, accepted.workId);
    assert.equal(work.acceptance?.hostAdmission?.state, 'rejected');
    assert.equal(work.lifecycle, 'committed');
    assert.equal(work.resultEventId, undefined);
  });
});

test('result returns through the real Connector outbox to the original place under the true author', async () => {
  await withWorld(async (world) => {
    const { operator } = world;
    const { accepted, source } = await inFlightWork(world);
    assert.equal(source.actor.kind, 'agent');
    const sourceRef = 'message:host-assignment-message';
    const resultKey = 'work:task-natural-1';
    const operation = await operator.connector.prepareReply(source, sourceRef, resultKey, 1, 1);
    // a Cat action outside a running turn is refused by the production verifier
    const ended = world.startTurn('codex-sol');
    world.endTurn(ended);
    await assert.rejects(
      operator.connector.submitReply(
        source,
        sourceRef,
        resultKey,
        operation.outboxId,
        'ghost result',
        world.agent('codex-sol', ended),
        undefined,
        1,
      ),
      { code: 'AGENT_PROVENANCE_UNVERIFIED' },
    );
    const running = world.startTurn('codex-sol');
    await operator.connector.submitReply(
      source,
      sourceRef,
      resultKey,
      operation.outboxId,
      'Here is the newcomer guide v1.',
      world.agent('codex-sol', running),
      undefined,
      1,
    );
    await operator.connector.sync(operator.connectionId);
    const work = workOf(world, accepted.workId);
    assert.equal(work.lifecycle, 'result_ready');
    const result = (await events(world)).find((event) => event.eventId === work.resultEventId);
    assert.ok(result);
    assert.equal(result.actor.kind === 'agent' && result.actor.provenance.connectionId, operator.connectionId);
    assert.equal(result.actor.kind === 'agent' && result.actor.provenance.catId, 'codex-sol');
    assert.equal(result.replyToEventId, accepted.assignmentEventId);
    assert.equal(result.location?.channelId, CHANNEL);
    assert.equal(result.workResultReceipt?.resultRevision, 1);
  });
});

test('feedback → v2 → acceptance closes only the current result; v1 can no longer be accepted and a replayed v1 does not overwrite', async () => {
  await withWorld(async (world) => {
    const { operator } = world;
    const { accepted, source } = await inFlightWork(world);
    await returnResult(world, source, 'guide', 1, 'Guide v1');
    const v1 = workOf(world, accepted.workId);
    assert.equal(v1.lifecycle, 'result_ready');
    const v1EventId = v1.resultEventId;
    assert.ok(v1EventId);

    const revised = await landyRequestsRevision(world, accepted.workId, 'Shorter, please.', 'revise-1');
    assert.equal(revised.lifecycle, 'in_progress');
    await world.syncAll();
    const revise = (await operator.connector.listInbox(operator.connectionId)).find(
      (item) => item.event.workRevisionNotice?.workId === accepted.workId,
    );
    assert.ok(revise, 'the signed revision notice reaches the accepting Café');
    assert.equal(revise.event.workRequest, 'revise');
    assert.equal(revise.event.replyToEventId, v1EventId);
    assert.equal(revise.event.workRevisionNotice?.assignmentEventId, accepted.assignmentEventId);

    await returnResult(world, source, 'guide', 2, 'Guide v2');
    const v2 = workOf(world, accepted.workId);
    assert.equal(v2.lifecycle, 'result_ready');
    assert.equal(v2.resultRevision, 2);
    assert.notEqual(v2.resultEventId, v1EventId);
    await assert.rejects(
      world.store.acceptCollectiveWorkResult(operator.sessionToken, {
        ...world.coordinates,
        requestId: 'accept-stale-v1',
        workId: accepted.workId,
        expectedRevision: v2.revision,
        resultEventId: v1EventId,
        resultRevision: 1,
      }),
      { code: 'WORK_RESULT_NOT_CURRENT' },
    );
    await operator.connector.sync(operator.connectionId);
    assert.equal(workOf(world, accepted.workId).resultEventId, v2.resultEventId);
    const done = await world.store.acceptCollectiveWorkResult(operator.sessionToken, {
      ...world.coordinates,
      requestId: 'accept-v2',
      workId: accepted.workId,
      expectedRevision: v2.revision,
      resultEventId: v2.resultEventId,
      resultRevision: 2,
    });
    assert.equal(done.lifecycle, 'completed');
    assert.equal(done.history.filter((entry) => entry.action === 'result_returned').length, 2);
  });
});

test('requester Human does not directly revise or accept accountable Work; authorized Cat continuation is separate', async () => {
  await withWorld(async (world) => {
    const { operator, wulang } = world;
    const { accepted, source } = await inFlightWork(world);
    const revision = (await operator.connector.getHostRoute(operator.connectionId))?.revision;
    assert.ok(revision);
    await returnResult(world, source, 'guide', 1, 'Guide v1');
    const ready = workOf(world, accepted.workId);
    const reviewInput = {
      ...world.coordinates,
      workId: accepted.workId,
      expectedRevision: ready.revision,
      resultEventId: ready.resultEventId,
      resultRevision: 1,
    };
    // accountable Human = the Café owner (You); the requester (Wulang) is not
    await assert.rejects(
      world.store.requestCollectiveWorkRevision(wulang.sessionToken, {
        ...reviewInput,
        requestId: 'requester-feedback',
        feedback: 'Too long',
      }),
      { code: 'WORK_AUTHORITY_REQUIRED' },
    );
    await assert.rejects(
      world.store.acceptCollectiveWorkResult(wulang.sessionToken, { ...reviewInput, requestId: 'requester-accepts' }),
      { code: 'WORK_AUTHORITY_REQUIRED' },
    );
    // a free-text reply on the result cannot be turned into a new Work: the matter must be continued
    const reply = await world.store.postHumanMessage(wulang.sessionToken, {
      ...world.coordinates,
      clientEventId: 'wulang-free-text-feedback',
      location: { channelId: CHANNEL },
      target: { kind: 'agent', humanId: operator.humanId, agentId: 'codex-sol' },
      recipient: {
        kind: 'agent',
        humanId: operator.humanId,
        connectionId: operator.connectionId,
        agentId: 'codex-sol',
        participationRevision: revision,
      },
      replyToEventId: ready.resultEventId,
      body: 'Could you make it shorter?',
    });
    await assert.rejects(catAccepts(world, operator, reply), refusedWith('WORK_CONTINUATION_REQUIRED'));
    assert.equal(
      world.store.listCollectiveCollaboration(operator.sessionToken, world.coordinates.collectiveId).works.length,
      1,
      'no second Work; but also no operation that continues the same Work from the requester’s feedback',
    );
  });
});

test('same Cat, two matters in one channel: feedback on A resumes only A and leaves B untouched', async () => {
  await withWorld(async (world) => {
    const { operator, wulang } = world;
    const revision = await world.declareCats(operator, ['codex-sol']);
    await world.declareCats(wulang, ['codex-sol']);
    await grantAndAdopt(world, operator);
    const requestA = await postNaturalRequest(world, wulang, operator, 'codex-sol', 'Matter A: the guide.', revision);
    const requestB = await postNaturalRequest(world, operator, operator, 'codex-sol', 'Matter B: the FAQ.', revision);
    const a = await acceptNaturally(world, requestA);
    const b = await acceptNaturally(world, requestB);
    assert.notEqual(a.accepted.workId, b.accepted.workId);
    assert.notEqual(a.accepted.assignmentEventId, b.accepted.assignmentEventId);
    assert.equal(a.accepted.assignment?.catId, b.accepted.assignment?.catId, 'the same Cat carries both matters');

    await returnResult(world, b.source, 'faq', 1, 'FAQ v1');
    await returnResult(world, a.source, 'guide', 1, 'Guide v1');
    const beforeB = workOf(world, b.accepted.workId);
    await landyRequestsRevision(world, a.accepted.workId, 'Guide: shorter.', 'revise-a');
    await world.syncAll();
    const notices = (await operator.connector.listInbox(operator.connectionId)).filter(
      (item) => item.event.workRevisionNotice,
    );
    assert.deepEqual(
      notices.map((item) => item.event.workRevisionNotice?.workId),
      [a.accepted.workId],
      'only A received a revision notice',
    );
    const afterB = workOf(world, b.accepted.workId);
    assert.equal(afterB.lifecycle, 'result_ready', 'B is not stopped by feedback on A');
    assert.equal(afterB.revision, beforeB.revision);
    assert.equal(afterB.resultEventId, beforeB.resultEventId);
    assert.equal(workOf(world, a.accepted.workId).lifecycle, 'in_progress');
    await returnResult(world, a.source, 'guide', 2, 'Guide v2');
    assert.equal(workOf(world, a.accepted.workId).resultRevision, 2);
    assert.equal(workOf(world, b.accepted.workId).resultEventId, beforeB.resultEventId);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Unrelated Host changes must not strand an in-flight Work; related revocation must still fail closed.
// ---------------------------------------------------------------------------------------------------------------

test('an attention change (standing interest) does not strand the in-flight Work', async () => {
  await withWorld(async (world) => {
    const { accepted, source } = await inFlightWork(world);
    const route = await world.operator.connector.getHostRoute(world.operator.connectionId);
    await world.operator.connector.setStandingInterest(
      world.operator.connectionId,
      { catId: 'codex-sol', channelId: CHANNEL, state: 'listen' },
      route?.attentionRevision ?? 0,
    );
    await returnResult(world, source, 'guide', 1, 'Guide v1');
    assert.equal(workOf(world, accepted.workId).lifecycle, 'result_ready');
  });
});

test('an unrelated Host participation edit (another Cat declared) does not strand the in-flight Work', async () => {
  await withWorld(async (world) => {
    const { accepted, source } = await inFlightWork(world);
    await world.declareCats(world.operator, ['codex-sol', 'codex-terra']); // unrelated to this matter
    const outcome = await returnResult(world, source, 'guide', 1, 'Guide v1').then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal(outcome, undefined, `return must still work, got: ${(outcome as Error | undefined)?.message}`);
    assert.equal(workOf(world, accepted.workId).lifecycle, 'result_ready');
  });
});

test('a related revocation (the accepting Cat leaves the public roster) still fails closed and never posts', async () => {
  await withWorld(async (world) => {
    const { accepted, source } = await inFlightWork(world);
    await world.declareCats(world.operator, ['codex-terra']); // codex-sol no longer participates
    await returnResult(world, source, 'guide', 1, 'Guide v1').catch(() => undefined);
    const work = workOf(world, accepted.workId);
    assert.notEqual(work.lifecycle, 'result_ready', 'a withdrawn Cat cannot return a result');
    assert.equal(work.resultEventId, undefined);
  });
});

test('Service and Connector restarts mid-Work keep the same matter; an offline return is retried exactly once', async () => {
  await withWorld(async (world) => {
    const { accepted, source } = await inFlightWork(world);
    await world.restartService();
    await world.restartConnector(world.operator);
    const sourceRef = 'message:host-guide';
    const resultKey = 'work:guide';
    const operation = await world.operator.connector.prepareReply(source, sourceRef, resultKey, 1, 1);
    const turn = world.startTurn('codex-sol');
    await world.operator.connector.submitReply(
      source,
      sourceRef,
      resultKey,
      operation.outboxId,
      'Guide v1',
      world.agent('codex-sol', turn),
      undefined,
      1,
    );
    await world.stopService();
    const offline = await world.operator.connector.sync(world.operator.connectionId);
    assert.equal(offline.liveStatus, 'offline');
    assert.equal(offline.outbox.queued, 1, 'the result waits in the durable outbox');
    await world.startService();
    await world.restartConnector(world.operator);
    await world.operator.connector.sync(world.operator.connectionId);
    await world.operator.connector.sync(world.operator.connectionId);
    assert.equal(workOf(world, accepted.workId).lifecycle, 'result_ready');
    const returned = (await events(world)).filter((event) => event.replyToEventId === accepted.assignmentEventId);
    assert.equal(returned.length, 1, 'the result was published once, not once per retry');
  });
});

test('a lost acceptance response is recovered from the durable operation: one Work, no duplicate assignment', async () => {
  await withWorld(async (world) => {
    const { operator, wulang } = world;
    const revision = await world.declareCats(operator, ['codex-sol']);
    await world.declareCats(wulang, ['codex-sol']);
    await grantAndAdopt(world, operator);
    const request = await postNaturalRequest(world, wulang, operator, 'codex-sol', 'Write the guide.', revision);
    world.loseNextAcceptResponse();
    await assert.rejects(catAccepts(world, operator, request)); // the Service committed; the Cat never heard back
    assert.equal(
      world.store.listCollectiveCollaboration(operator.sessionToken, world.coordinates.collectiveId).works.length,
      1,
      'the Service did commit exactly one Work',
    );
    await world.restartConnector(operator);
    await operator.connector.sync(operator.connectionId); // recover() replays the prepared operation
    const again = await catAccepts(world, operator, request);
    const works = world.store.listCollectiveCollaboration(operator.sessionToken, world.coordinates.collectiveId).works;
    assert.equal(works.length, 1);
    assert.equal(again.workId, works[0]?.workId);
    assert.equal((await events(world)).filter((event) => event.workRequest === 'entrust').length, 1);
    const inbox = await operator.connector.listInbox(operator.connectionId);
    assert.equal(inbox.filter((item) => item.event.workRequest === 'entrust').length, 1);
  });
});

test('CHARACTERIZATION (observation): acceptance while the Service is unreachable is not durable, so no phantom Work exists and a later attempt is clean', async () => {
  await withWorld(async (world) => {
    const { operator, wulang } = world;
    const revision = await world.declareCats(operator, ['codex-sol']);
    await world.declareCats(wulang, ['codex-sol']);
    await grantAndAdopt(world, operator);
    const request = await postNaturalRequest(world, wulang, operator, 'codex-sol', 'Write the guide.', revision);
    await world.stopService();
    // requireGrant validates the registered policy online BEFORE the operation is prepared: fail closed, nothing kept
    await assert.rejects(catAccepts(world, operator, request));
    await world.startService();
    await operator.connector.sync(operator.connectionId);
    assert.equal(
      world.store.listCollectiveCollaboration(operator.sessionToken, world.coordinates.collectiveId).works.length,
      0,
      'no phantom Work: the Cat\u2019s intent was not silently kept and replayed under a possibly changed grant',
    );
    assert.ok((await catAccepts(world, operator, request)).workId);
  });
});
