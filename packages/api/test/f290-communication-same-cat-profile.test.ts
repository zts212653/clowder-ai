import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { CollectiveConnector as BuiltConnector } from '@cat-cafe/collective-connector';
import { CollectiveServiceStore as BuiltServiceStore } from '@cat-cafe/collective-service';
import { CollectiveConnector as SourceConnector } from '../../collective-connector/src/connector.js';
import { workOutboundIntent } from '../../collective-connector/src/work-outbound-authority.js';
import { CollectiveServiceStore as SourceServiceStore } from '../../collective-service/src/store.js';
import { createCollectiveAgentVerifier } from '../src/domains/plugin/builtin-runtime/collective-agent-verifier.js';
import { fixture } from './f290-communication-current-execution.fixture.js';
import { workOf } from './f290-communication-validation.harness.js';
import { CAT } from './f290-communication-validation.host.js';

const CURRENT_NAME = 'Sol · current cosmetic name';
const Connector = process.env.F290_PROFILE_SOURCE_SERVICE === '1' ? SourceConnector : BuiltConnector;

// Optional source-only run during a compiled-runtime freeze. Real Store, disk and
// HTTP transport remain in use; the canonical default exercises the built SDK/Service.
if (process.env.F290_PROFILE_SOURCE_SERVICE === '1') {
  const sourceOpen = mock.method(BuiltServiceStore, 'open', SourceServiceStore.open);
  after(() => sourceOpen.mock.restore());
}

/** Actual Host Work admission + Service HTTP/disk. OAuth, profile registry and running-model map are explicit fixtures. */
async function profileFixture() {
  const f = await fixture();
  let currentName = 'Sol';
  let loseResponse = false;
  const verifyAgent = createCollectiveAgentVerifier({
    resolveCatDisplayName: (catId) => (catId === CAT ? currentName : undefined),
    readTurnExecution: (id) => f.world.turns.get(id),
  });
  const connector = await Connector.open({
    dataDirectory: f.cafe.dataDirectory,
    verifyAgent,
    fetchImpl: async (input, init) => {
      const response = await fetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === '/api/events/agent' && loseResponse) {
        loseResponse = false;
        throw new TypeError('fixture response lost AFTER real Service event commit');
      }
      return response;
    },
  });
  // Reopen the same durable Connector, preserving all existing Work/admission facts.
  Object.assign(f.cafe, { connector });
  const birthTask = structuredClone(await f.tasks.get(f.task.id));
  const birthWork = structuredClone(workOf(f.world, f.work.workId));
  const current = await f.context.current(f.firstAuth);
  const binding = await f.context.resolvePrivate(f.firstAuth, 'callback');
  assert.ok(binding);
  const execution = { revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId };
  const agent = () => ({ catId: CAT, agentId: CAT, displayName: currentName, sessionRef: f.firstAuth.invocationId });
  const rename = async () => {
    const previous = await connector.getHostRoute(f.cafe.connectionId);
    assert.ok(previous);
    const routes = structuredClone(previous.agentRoutes);
    const participant = routes[`${f.cafe.humanId}:${CAT}`]?.participation;
    assert.ok(participant);
    participant.displayName = CURRENT_NAME;
    currentName = CURRENT_NAME;
    const changed = await connector.setHostRoute(
      f.cafe.connectionId,
      {
        localOwnerUserId: previous.localOwnerUserId,
        defaultIngressThreadId: previous.defaultIngressThreadId,
        humanNotificationThreadId: previous.humanNotificationThreadId,
        agentRoutes: routes,
        publicProfiles: { ...previous.publicProfiles, [CAT]: { description: 'Cosmetic profile fixture only' } },
      },
      previous.revision,
    );
    assert.deepEqual(
      changed.scopeStarts,
      previous.scopeStarts,
      'cosmetic change preserves the same participant permission epoch',
    );
    await connector.publishParticipation(f.cafe.connectionId);
    assert.ok(await verifyAgent(agent()), 'same real running-turn record verifies the current profile');
    assert.deepEqual(await f.tasks.get(f.task.id), birthTask, 'rename cannot rewrite Task birth/admission');
    const fresh = workOf(f.world, f.work.workId);
    assert.deepEqual(
      fresh.assignment,
      birthWork.assignment,
      'first historical assignment retains original Cat ID/name',
    );
    assert.deepEqual(
      fresh.acceptance,
      birthWork.acceptance,
      'grant and protected Host admission remain the same facts',
    );
    const resolved = await f.context.resolvePrivate(f.firstAuth, 'callback');
    assert.ok(resolved);
    assert.equal(resolved.displayName, CURRENT_NAME);
    assert.equal(resolved.work.executionRevision, binding.work.executionRevision);
    return resolved;
  };
  const queueResult = async (body: string) => {
    const operation = await connector.prepareReply(
      binding.source,
      binding.sourceRef,
      binding.work.resultKey,
      binding.work.revision,
      binding.work.resultRevision,
      execution,
    );
    const queued = await connector.submitReply(
      binding.source,
      binding.sourceRef,
      binding.work.resultKey,
      operation.outboxId,
      body,
      agent(),
      undefined,
      binding.work.resultRevision,
      execution,
    );
    assert.equal(queued.status, 'queued');
    assert.equal(queued.agent?.displayName, 'Sol');
    return queued;
  };
  const events = () => f.world.store.listEventsForHuman(f.cafe.sessionToken, f.world.coordinates.collectiveId);
  return {
    ...f,
    connector,
    current,
    binding,
    execution,
    agent,
    rename,
    queueResult,
    events,
    loseNextResponse: () => {
      loseResponse = true;
    },
  };
}

test('same Cat cosmetic profile change cannot strand its verified queued result; new event uses current name, birth history stays original', async () => {
  const f = await profileFixture();
  try {
    const queued = await f.queueResult('queued result before cosmetic rename');
    await f.rename();
    await f.connector.sync(f.cafe.connectionId);
    const recovered = await f.connector.prepareReply(
      f.binding.source,
      f.binding.sourceRef,
      f.binding.work.resultKey,
      f.binding.work.revision,
      f.binding.work.resultRevision,
      f.execution,
    );
    const publications = (await f.events()).filter((event) => event.clientEventId === queued.clientEventId);
    assert.equal(
      recovered.status,
      'accepted',
      `valid queued execution was stranded: ${recovered.status}/${recovered.failureCode}`,
    );
    assert.equal(publications.length, 1);
    assert.deepEqual(recovered.agent, queued.agent, 'recovery preserves the original verified wire author/session');
    assert.deepEqual(
      recovered.workPurpose,
      { ...queued.workPurpose, workId: f.work.workId },
      'Service receipt adds its canonical Work ID without changing the queued purpose',
    );
    assert.deepEqual(recovered.replySource, queued.replySource, 'recovery preserves the original source');
    assert.equal(publications[0]?.actor.kind, 'agent');
    if (publications[0]?.actor.kind === 'agent') assert.equal(publications[0].actor.agent.displayName, CURRENT_NAME);
    assert.equal(workOf(f.world, f.work.workId).lifecycle, 'result_ready');
  } finally {
    await f.world.close();
  }
});

test('same running Cat can recover exact queued progress after cosmetic rename without another event or new Task', async () => {
  const f = await profileFixture();
  try {
    const body = 'queued progress before cosmetic rename';
    const purpose = {
      source: f.binding.source,
      sourceRef: f.binding.sourceRef,
      resultKey: f.binding.work.resultKey,
      taskRevision: f.binding.work.revision,
      resultRevision: f.binding.work.resultRevision,
      executionRevision: f.execution.revision,
      assignmentEventId: f.execution.assignmentEventId,
      authorCatId: CAT,
      body,
    };
    const operation = await f.connector.prepareProgress(purpose);
    const queued = await f.connector.submitProgress(purpose, operation.outboxId, f.agent());
    assert.equal(queued.agent?.displayName, 'Sol');
    await f.rename();
    assert.ok(f.current.progressOperationRef);
    await f.context.progress(f.firstAuth, f.current.returnRef, f.current.progressOperationRef, body);
    await f.context.progress(f.firstAuth, f.current.returnRef, f.current.progressOperationRef, body);
    const publications = (await f.events()).filter((event) => event.clientEventId === queued.clientEventId);
    assert.equal(publications.length, 1);
    assert.equal(
      workOf(f.world, f.work.workId).history.filter((entry) => entry.action === 'progress_reported').length,
      1,
    );
    assert.equal((await f.tasks.listByKind('work')).length, 1);
  } finally {
    await f.world.close();
  }
});

test('already accepted result with lost response recovers its exact original event after rename; no new published Work/Task', async () => {
  const f = await profileFixture();
  try {
    const body = 'result committed before cosmetic rename';
    const queued = await f.queueResult(body);
    f.loseNextResponse();
    await f.connector.sync(f.cafe.connectionId);
    assert.equal(
      workOf(f.world, f.work.workId).lifecycle,
      'result_ready',
      'Service really accepted the result before losing its response',
    );
    const first = (await f.events()).find((event) => event.clientEventId === queued.clientEventId);
    assert.ok(first);
    await f.rename();
    await f.context.reply(f.firstAuth, f.current.returnRef, f.current.replyOperationRef, body);
    await f.context.reply(f.firstAuth, f.current.returnRef, f.current.replyOperationRef, body);
    const publications = (await f.events()).filter((event) => event.clientEventId === queued.clientEventId);
    assert.equal(publications.length, 1);
    assert.equal(publications[0]?.eventId, first.eventId);
    if (publications[0]?.actor.kind === 'agent')
      assert.equal(
        publications[0].actor.agent.displayName,
        'Sol',
        'already published historical author stays original',
      );
    assert.equal((await f.tasks.listByKind('work')).length, 1);
    assert.equal(
      f.world.store.listCollectiveCollaboration(f.cafe.sessionToken, f.world.coordinates.collectiveId).works.length,
      1,
    );
  } finally {
    await f.world.close();
  }
});

test('current caller verification rejects a spoofed profile or another Cat; Service derives a new author from its exact participant', async () => {
  const f = await profileFixture();
  try {
    await f.rename();
    const operation = await f.connector.prepareReply(
      f.binding.source,
      f.binding.sourceRef,
      f.binding.work.resultKey,
      f.binding.work.revision,
      f.binding.work.resultRevision,
      f.execution,
    );
    const submit = (agent: ReturnType<typeof f.agent>) =>
      f.connector.submitReply(
        f.binding.source,
        f.binding.sourceRef,
        f.binding.work.resultKey,
        operation.outboxId,
        'canonical author only',
        agent,
        undefined,
        f.binding.work.resultRevision,
        f.execution,
      );
    await assert.rejects(submit({ ...f.agent(), displayName: 'Forged owner name' }), {
      code: 'AGENT_PROVENANCE_UNVERIFIED',
    });
    await assert.rejects(submit({ ...f.agent(), catId: 'codex-terra', agentId: 'codex-terra' }), {
      code: 'AGENT_PROVENANCE_UNVERIFIED',
    });
    const queued = await submit(f.agent());
    const request = {
      ...f.world.coordinates,
      connectionId: f.cafe.connectionId,
      clientEventId: queued.clientEventId,
      target: queued.target,
      location: queued.location,
      replyToEventId: queued.replyToEventId,
      participationRevision: f.binding.source.participationRevision,
      agent: { ...f.agent(), displayName: 'Forged Service wire name' },
      ...workOutboundIntent(queued),
      body: queued.body,
    };
    const credential = await f.world.endpointCredential(f.cafe);
    assert.ok(credential);
    await assert.rejects(
      f.world.store.postAgentMessage(credential, {
        ...request,
        connectionId: f.world.wulang.connectionId,
      }),
      { code: 'CONNECTION_NOT_FOUND' },
    );
    const published = await f.world.store.postAgentMessage(credential, request);
    assert.equal(published.actor.kind, 'agent');
    if (published.actor.kind === 'agent') {
      assert.equal(published.actor.agent.displayName, CURRENT_NAME);
      assert.equal(published.actor.provenance.catId, CAT);
      assert.equal(published.actor.provenance.connectionId, f.cafe.connectionId);
    }
    await assert.rejects(
      f.world.store.postAgentMessage(credential, {
        ...request,
        agent: { ...request.agent, sessionRef: 'forged-different-session' },
      }),
      { code: 'CLIENT_EVENT_CONFLICT' },
    );
    await assert.rejects(
      f.world.store.postAgentMessage(credential, {
        ...request,
        body: 'replace the accepted result',
      }),
      { code: 'CLIENT_EVENT_CONFLICT' },
    );
    assert.equal((await f.events()).filter((event) => event.clientEventId === queued.clientEventId).length, 1);
    assert.equal((await f.tasks.listByKind('work')).length, 1);
  } finally {
    await f.world.close();
  }
});

test('fresh prepared current return under cosmetic profile update remains authorized (control)', async () => {
  const f = await profileFixture();
  try {
    await f.rename();
    await f.context.reply(
      f.firstAuth,
      f.current.returnRef,
      f.current.replyOperationRef,
      'fresh result after cosmetic rename',
    );
    const result = workOf(f.world, f.work.workId);
    assert.equal(result.lifecycle, 'result_ready');
    const event = (await f.events()).find((candidate) => candidate.eventId === result.resultEventId);
    assert.ok(event);
    if (event.actor.kind === 'agent') assert.equal(event.actor.agent.displayName, CURRENT_NAME);
  } finally {
    await f.world.close();
  }
});
