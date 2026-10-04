/**
 * F290 communication — Host consumer contracts for the assignment source, driven by REAL Service Work projections and
 * the production Host composition (see f290-communication-validation.host.ts for the exact production/fixture split:
 * the model is a scripted Cat, the stores are in-memory, `api/src/index.ts` is mirrored, not started).
 *
 * The shared matcher `collectiveWorkAssignmentMatches` now decides whether an assignment source is genuine. These tests
 * pin it from the consumer side: a naturally accepted Work closes/returns only through a matching agent-authored source;
 * a Human-authored source must NOT vouch for a Work that carries an agent acceptance (the two contradict); a genuine
 * Human commit still works; and forged sources are refused without side effects.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type CollectiveWorkProjection, collectiveEventSourceIdentity } from '@cat-cafe/shared';
import type { IMessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { resolveCollectiveStandingGrant } from '../src/domains/plugin/builtin-runtime/collective-standing-grant.js';
import { CollectiveWorkResultReconciler } from '../src/domains/plugin/builtin-runtime/collective-work-result-reconciler.js';
import {
  createWorld,
  grantAndAdopt,
  postNaturalRequest,
  type World,
  workOf,
} from './f290-communication-validation.harness.js';
import { CAT, createHost, type Host, pumpUntil } from './f290-communication-validation.host.js';

async function withHost(run: (world: World, host: Host) => Promise<void>) {
  const world = await createWorld();
  try {
    await run(world, await createHost(world, world.operator));
  } finally {
    await world.close();
  }
}

const ingressKey = (world: World, eventId: string) =>
  `collective-ingress:${world.coordinates.serviceInstanceId}:${world.coordinates.collectiveId}:${eventId}`;
const worksOf = (world: World) =>
  world.store.listCollectiveCollaboration(world.operator.sessionToken, world.coordinates.collectiveId).works;

/** A naturally accepted, executed, Human-accepted Work, left for the caller to reconcile. */
async function completedNaturalWork(world: World, host: Host) {
  await grantAndAdopt(world, world.operator);
  const request = await postNaturalRequest(
    world,
    world.wulang,
    world.operator,
    'codex-sol',
    'Matter N: the guide',
    host.participationRevision,
  );
  const find = () => worksOf(world).find((candidate) => candidate.sourceEventId === request.eventId);
  await pumpUntil([host], world, () => find()?.lifecycle === 'result_ready', 'the natural Work returns a result');
  const ready = find();
  assert.ok(ready);
  await world.store.acceptCollectiveWorkResult(world.operator.sessionToken, {
    ...world.coordinates,
    requestId: `accept-${ready.workId}`,
    workId: ready.workId,
    expectedRevision: ready.revision,
    resultEventId: ready.resultEventId,
    resultRevision: 1,
  });
  const work = workOf(world, ready.workId);
  const [task] = await host.tasks.listByKind('work');
  assert.ok(task?.entrustedWork);
  const sourceMessageId = task.entrustedWork.admission.sourceRefs[0]?.slice('message:'.length);
  assert.ok(sourceMessageId);
  const source = await host.messages.getById(sourceMessageId);
  assert.ok(source);
  return { request, work, task, source };
}

test('the accepted assignment is persisted as the Host source, carries the Service notice, and its Task takes the Work’s outcome', async () => {
  await withHost(async (world, host) => {
    const { request, work, task, source } = await completedNaturalWork(world, host);
    const inbox = await world.operator.connector.listInbox(world.operator.connectionId);
    assert.equal(
      inbox.find((item) => item.event.eventId === work.assignmentEventId)?.routeReceipt?.kind,
      'thread_message',
      'the acceptance is routed, not dropped as the Cat’s own echo',
    );
    assert.equal(
      (
        await host.messages.getByIdempotencyKey(
          host.userId,
          host.endpoint.id,
          ingressKey(world, work.assignmentEventId as string),
        )
      )?.id,
      source.id,
    );
    const participation = source.source?.meta?.participation as { actor: { kind: string }; eventId: string };
    assert.equal(participation.actor.kind, 'agent', 'no Human click is forged into the source');
    assert.equal(participation.eventId, work.assignmentEventId);
    assert.equal((source.source?.meta?.workAcceptanceNotice as { workId: string }).workId, work.workId);
    assert.equal(
      task.entrustedWork?.intendedOutcome,
      request.body,
      'the private Task outcome is the Work’s outcome, not the public acknowledgement text',
    );
    assert.notEqual(task.entrustedWork?.intendedOutcome, source.content);
  });
});

test('a forged agent source is never resolved to a grant: the request event cannot masquerade as the Cat’s acceptance', async () => {
  await withHost(async (world, host) => {
    const { operator } = world;
    await grantAndAdopt(world, operator);
    const request = await postNaturalRequest(
      world,
      world.wulang,
      operator,
      'codex-sol',
      'Forge me',
      host.participationRevision,
    );
    const identity = collectiveEventSourceIdentity(request);
    assert.ok(identity);
    const forged = host.messages.append({
      userId: host.userId,
      threadId: host.endpoint.id,
      catId: null,
      mentions: [CAT],
      timestamp: Date.now(),
      content: 'Forge me',
      source: {
        connector: 'collective',
        label: 'Collective',
        icon: 'collective',
        meta: {
          workRequest: 'entrust',
          participation: {
            ...identity,
            actor: {
              kind: 'agent',
              human: { humanId: operator.humanId, displayName: 'You' },
              agent: { agentId: CAT, displayName: 'Sol' },
              provenance: {
                connectionId: operator.connectionId,
                endpointId: operator.endpointId,
                endpointLabel: 'operator Café',
                catId: CAT,
                sessionRef: 'invocation:forged',
              },
            },
          },
        },
      },
    });
    const outcome = await resolveCollectiveStandingGrant(operator.connector, forged, CAT).then(
      (value) => value,
      (error: unknown) => error,
    );
    assert.ok(outcome === undefined || outcome instanceof Error, 'no grant may be minted for a forged source');
    assert.equal((await host.tasks.listByKind('work')).length, 0);
  });
});

test('result reconciler: a Human-authored view of a naturally accepted Work is refused; forgeries are refused; only the genuine agent source closes the Task', async () => {
  await withHost(async (world, host) => {
    const { work, task, source } = await completedNaturalWork(world, host);
    const reconcile = (view: CollectiveWorkProjection, messages: Pick<IMessageStore, 'getById'> = host.messages) =>
      new CollectiveWorkResultReconciler({ messages, tasks: host.tasks }).reconcile({
        ownerUserId: host.userId,
        sourceMessageId: source.id,
        work: view,
      });
    const identity = (source.source?.meta?.participation ?? {}) as {
      actor: { kind: 'agent'; human: { humanId: string; displayName: string } };
    };
    const withMeta = (patch: Record<string, unknown>) => ({
      async getById(id: string) {
        const message = await host.messages.getById(id);
        if (!message?.source) return message;
        return { ...message, source: { ...message.source, meta: { ...message.source.meta, ...patch } } };
      },
    });

    // Human source + agent acceptance contradict each other: a Human view must not vouch for this Work.
    await assert.rejects(
      reconcile(
        work,
        withMeta({
          participation: {
            ...identity,
            actor: {
              kind: 'human',
              humanId: identity.actor.human.humanId,
              displayName: identity.actor.human.displayName,
            },
          },
        }),
      ),
      { code: 'COLLECTIVE_RESULT_SOURCE_MISMATCH' },
    );
    const forgeries: Array<[string, CollectiveWorkProjection, ReturnType<typeof withMeta>?]> = [
      ['acceptance stripped (a legacy Work does not vouch for an agent source)', { ...work, acceptance: undefined }],
      [
        'acceptance names another source event',
        { ...work, acceptance: work.acceptance && { ...work.acceptance, sourceEventId: 'evt_forged00000' } },
      ],
      [
        'assignment belongs to another connection',
        { ...work, assignment: work.assignment && { ...work.assignment, connectionId: world.wulang.connectionId } },
      ],
      [
        'assignment belongs to another Cat',
        { ...work, assignment: work.assignment && { ...work.assignment, catId: 'codex-terra' } },
      ],
      [
        'tampered Host notice (operationRef)',
        work,
        withMeta({
          workAcceptanceNotice: { ...(source.source?.meta?.workAcceptanceNotice as object), operationRef: 'forged' },
        }),
      ],
      [
        'Host notice names another Work',
        work,
        withMeta({
          workAcceptanceNotice: { ...(source.source?.meta?.workAcceptanceNotice as object), workId: 'work_forged0000' },
        }),
      ],
      ['missing Host notice', work, withMeta({ workAcceptanceNotice: undefined })],
    ];
    for (const [label, view, messages] of forgeries) {
      await assert.rejects(reconcile(view, messages), (error: unknown) => error instanceof Error, label);
      assert.equal((await host.tasks.get(task.id))?.entrustedWork?.closure.state, 'open', `${label}: Task stays open`);
    }
    // The same data, genuine: closes. So every refusal above was about the forgery, not a broken fixture.
    assert.equal((await reconcile(work)).result, 'closed');
  });
});

test('legacy control: an actual Human commit still runs through the Host and closes its Task from a Human source', async () => {
  await withHost(async (world, host) => {
    const { operator, wulang } = world;
    // owner opt-in written into the Host route (legacy standing scope), then the Human commits and assigns
    const revision = await world.declareCats(operator, [CAT], {
      threadId: host.endpoint.id,
      standingWork: { requestingHumanIds: [operator.humanId], channelIds: ['general'], expiresAt: null },
    });
    const request = await postNaturalRequest(world, wulang, operator, 'codex-sol', 'Legacy matter: FAQ', revision);
    const proposed = await world.store.proposeCollectiveWork(operator.sessionToken, {
      ...world.coordinates,
      requestId: 'legacy-propose',
      sourceEventId: request.eventId,
      title: 'Legacy FAQ',
      intendedOutcome: 'Legacy matter: FAQ',
    });
    const committed = await world.store.commitCollectiveWork(operator.sessionToken, {
      ...world.coordinates,
      requestId: 'legacy-commit',
      workId: proposed.workId,
      expectedRevision: proposed.revision,
      assignment: { connectionId: operator.connectionId, catId: CAT, participationRevision: revision },
    });
    assert.equal(committed.acceptance, undefined, 'a Human commit carries no Cat acceptance');
    await pumpUntil(
      [host],
      world,
      () => workOf(world, proposed.workId).lifecycle === 'result_ready',
      'the legacy Work returns a result',
    );
    const ready = workOf(world, proposed.workId);
    await world.store.acceptCollectiveWorkResult(operator.sessionToken, {
      ...world.coordinates,
      requestId: 'legacy-accept',
      workId: ready.workId,
      expectedRevision: ready.revision,
      resultEventId: ready.resultEventId,
      resultRevision: 1,
    });
    const [task] = await host.tasks.listByKind('work');
    const sourceMessageId = task?.entrustedWork?.admission.sourceRefs[0]?.slice('message:'.length);
    assert.ok(sourceMessageId);
    const source = await host.messages.getById(sourceMessageId);
    assert.equal((source?.source?.meta?.participation as { actor: { kind: string } }).actor.kind, 'human');
    const outcome = await host.resultReconciler.reconcile({
      ownerUserId: host.userId,
      sourceMessageId,
      work: workOf(world, ready.workId),
    });
    assert.equal(outcome.result, 'closed');
  });
});

test('an original Human message flagged workRequest=entrust, with no Service-committed assignment, cannot create a private Task; the same matter committed through the Service can', async () => {
  await withHost(async (world, host) => {
    const { operator, wulang } = world;
    // The legacy owner opt-in lists the requester: before any Service commitment this must still authorize nothing.
    const revision = await world.declareCats(operator, [CAT], {
      threadId: host.endpoint.id,
      standingWork: {
        requestingHumanIds: [wulang.humanId, operator.humanId],
        channelIds: ['general'],
        expiresAt: null,
      },
    });
    const entrust = await world.store.postHumanMessage(wulang.sessionToken, {
      ...world.coordinates,
      clientEventId: 'plain-entrust-without-commitment',
      location: { channelId: 'general' },
      target: { kind: 'agent', humanId: operator.humanId, agentId: CAT },
      recipient: {
        kind: 'agent',
        humanId: operator.humanId,
        connectionId: operator.connectionId,
        agentId: CAT,
        participationRevision: revision,
      },
      workRequest: 'entrust',
      body: 'Please take this on: the FAQ',
    });
    await host.tick();
    await host.tick();
    const privateThreads = (await host.threads.list(host.userId)).filter((thread) => thread.id !== host.endpoint.id);
    assert.deepEqual(
      {
        tasks: (await host.tasks.listByKind('work')).length,
        privateRuns: host.runs.filter((run) => run.scope === 'private').length,
        workThreads: privateThreads.filter((thread) => thread.id.startsWith('thread_owned_')).length,
        serviceWorks: worksOf(world).length,
      },
      { tasks: 0, privateRuns: 0, workThreads: 0, serviceWorks: 0 },
      'a Composer flag on a Human message is not a Service-committed assignment: no Task, no Thread, no execution',
    );

    // Control: the same matter, actually committed through the Service by the accountable Human, runs and returns.
    const proposed = await world.store.proposeCollectiveWork(operator.sessionToken, {
      ...world.coordinates,
      requestId: 'commit-the-same-matter-propose',
      sourceEventId: entrust.eventId,
      title: 'FAQ',
      intendedOutcome: 'Please take this on: the FAQ',
    });
    await world.store.commitCollectiveWork(operator.sessionToken, {
      ...world.coordinates,
      requestId: 'commit-the-same-matter',
      workId: proposed.workId,
      expectedRevision: proposed.revision,
      assignment: { connectionId: operator.connectionId, catId: CAT, participationRevision: revision },
    });
    await pumpUntil(
      [host],
      world,
      () => workOf(world, proposed.workId).lifecycle === 'result_ready',
      'the Service-committed matter returns a result',
    );
    assert.equal((await host.tasks.listByKind('work')).length, 1, 'exactly one Task, born only after the commitment');
    assert.equal(host.runs.filter((run) => run.scope === 'private').length, 1);
  });
});
