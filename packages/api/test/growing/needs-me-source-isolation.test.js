import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { EntrustedWorkOwnerReadService } = await import('../../dist/domains/growing/EntrustedWorkOwnerReadService.js');
const { NeedsMeProducerCatalog } = await import('../../dist/domains/growing/NeedsMeProducerCatalog.js');
const { readCompanionDecisionProjection } = await import('../../dist/routes/companion-decision-read-service.js');
const { registerEntrustedWorkReadRoutes } = await import('../../dist/routes/entrusted-work-read-routes.js');

const now = 1_792_669_000_000;

function entrustedTask(id, title) {
  return {
    id,
    threadId: `thread-${id}`,
    title,
    why: 'Source-backed work',
    status: 'doing',
    createdBy: 'codex-sol',
    ownerCatId: 'codex-sol',
    userId: 'owner',
    kind: 'work',
    subjectKey: `entrusted:${id}`,
    createdAt: now,
    updatedAt: now,
    entrustedWork: {
      revision: 1,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:source-${id}`],
        idempotencyKey: `entrusted:${id}`,
        receiptRef: `task:receipt:${id}`,
        admittedAt: now,
      },
      intendedOutcome: `Deliver ${title}`,
      time: {},
      artifactRefs: [`artifact:${id}`],
      closure: {
        condition: 'Owner can inspect the result',
        expectedSignal: `artifact:${id}`,
        state: 'open',
        evidenceRefs: [],
      },
    },
  };
}

function emptyAdapter(producerId) {
  return {
    producerId,
    async listCurrentReceipts() {
      return [];
    },
    async readCurrentReceipt() {
      return null;
    },
  };
}

function healthyReceipt() {
  return {
    eligible: true,
    producer: {
      producerId: 'f309.content_review',
      ownerRef: 'review:healthy',
      subjectRef: 'review:healthy',
      revision: 4,
    },
    taskRef: { subjectRef: 'task:work:healthy', observedRevision: 1 },
    kind: 'judgment',
    reasonCode: 'review_ready',
    recommendation: 'Review the prepared result',
    salience: 'normal',
    action: { actionRef: 'review:healthy#decide', expectedProducerRevision: 4 },
    reEvaluateActionRef: 'review:healthy#reevaluate',
  };
}

test('one unavailable producer preserves healthy Needs Me, owner facts, and partial coverage until recovery', async (t) => {
  const tasks = new Map([
    ['healthy', entrustedTask('healthy', 'Healthy producer work')],
    ['unrelated', entrustedTask('unrelated', 'Unrelated factual work')],
  ]);
  let collectiveAvailable = false;
  const catalog = new NeedsMeProducerCatalog([
    emptyAdapter('f246.approval'),
    emptyAdapter('f292.repair'),
    emptyAdapter('f306.runtime_interaction'),
    {
      ...emptyAdapter('f309.content_review'),
      async listCurrentReceipts() {
        return [healthyReceipt()];
      },
    },
    {
      ...emptyAdapter('f290.collective_work_result'),
      async listCurrentReceipts() {
        if (!collectiveAvailable) throw new Error('Collective result attention source is unavailable');
        return [];
      },
    },
  ]);
  const service = new EntrustedWorkOwnerReadService({
    tasks: {
      async get(id) {
        return structuredClone(tasks.get(id) ?? null);
      },
      async listByKind() {
        return [...tasks.values()].map((task) => structuredClone(task));
      },
    },
    producerCatalog: catalog,
    artifactReader: {
      async readPreparedArtifact({ artifactRef, taskRevision }) {
        return {
          artifactRef,
          artifactRevision: String(taskRevision),
          completenessRef: `${artifactRef}#complete:${taskRevision}`,
          previewRef: `${artifactRef}#preview:${taskRevision}`,
          openInWorkspaceRef: `workspace:${artifactRef}:${taskRevision}`,
        };
      },
    },
  });
  const registry = new InvocationRegistry();
  const app = Fastify();
  t.after(() => app.close());
  app.get('/api/approval-hub/pending', async () => ({ items: [], coverage: { state: 'complete' } }));
  registerEntrustedWorkReadRoutes(app, { service, callbackRegistry: registry });

  const unavailableSource = {
    producerId: 'f290.collective_work_result',
    status: 'unavailable',
    reason: 'source_unavailable',
  };

  const needsMe = await app.inject({
    method: 'GET',
    url: '/api/entrusted-work/needs-me',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(needsMe.statusCode, 200);
  assert.deepEqual(needsMe.json().coverage, { state: 'partial', unavailableSources: [unavailableSource] });
  assert.deepEqual(
    needsMe.json().ownerReads.map((read) => read.envelope.subjectRef),
    ['task:work:healthy'],
  );
  assert.equal(needsMe.json().ownerReads[0].attentionReceipts[0].producer.producerId, 'f309.content_review');

  const active = await app.inject({
    method: 'GET',
    url: '/api/entrusted-work/owner-reads',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(active.statusCode, 200);
  assert.deepEqual(active.json().coverage, { state: 'partial', unavailableSources: [unavailableSource] });
  assert.equal(active.json().ownerReads.length, 2);
  const unrelated = active.json().ownerReads.find((read) => read.envelope.subjectRef === 'task:work:unrelated');
  assert.equal(unrelated.work.title, 'Unrelated factual work');
  assert.deepEqual(unrelated.attentionCoverage, { state: 'partial', unavailableSources: [unavailableSource] });
  assert.deepEqual(unrelated.attentionReceipts, []);
  assert.deepEqual(unrelated.brief.needsMe, {
    state: 'unknown',
    reason: 'attention_source_unavailable',
  });
  assert.deepEqual(unrelated.brief.nextOwner, { kind: 'unknown' });

  const ownerRead = await app.inject({
    method: 'GET',
    url: '/api/entrusted-work/unrelated/owner-read',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(ownerRead.statusCode, 200);
  assert.equal(ownerRead.json().ownerRead.work.title, 'Unrelated factual work');
  assert.deepEqual(ownerRead.json().ownerRead.attentionCoverage, {
    state: 'partial',
    unavailableSources: [unavailableSource],
  });

  const credentials = await registry.create('owner', 'codex-sol', 'thread-unrelated', undefined, undefined, {
    mode: 'read_only',
    replayDeniedToolNames: [],
  });
  const callback = await app.inject({
    method: 'POST',
    url: '/api/callbacks/read-entrusted-work',
    headers: {
      'x-invocation-id': credentials.invocationId,
      'x-callback-token': credentials.callbackToken,
    },
    payload: { taskId: 'unrelated' },
  });
  assert.equal(callback.statusCode, 200);
  assert.deepEqual(callback.json().ownerRead.attentionCoverage, {
    state: 'partial',
    unavailableSources: [unavailableSource],
  });
  assert.deepEqual(callback.json().ownerRead.brief.nextOwner, { kind: 'unknown' });

  const mailbox = await readCompanionDecisionProjection(app, 'owner', { offset: 0, limit: 20 });
  assert.equal(mailbox.sources.needsMe.status, 'available');
  assert.equal(mailbox.sources.needsMe.exhaustiveness, 'partial');
  assert.ok(mailbox.items.some((item) => item.decisionRef === 'f309.content_review:review:healthy'));
  assert.equal(mailbox.totalCount, undefined, 'partial coverage cannot certify an exact empty or total count');

  collectiveAvailable = true;
  const recovered = await app.inject({
    method: 'GET',
    url: '/api/entrusted-work/unrelated/owner-read',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(recovered.statusCode, 200);
  assert.deepEqual(recovered.json().ownerRead.attentionCoverage, { state: 'complete' });
  assert.deepEqual(recovered.json().ownerRead.brief.needsMe, {
    state: 'not_needed',
    evidenceRef: 'task:item:unrelated',
    revision: 1,
  });
  assert.deepEqual(recovered.json().ownerRead.brief.nextOwner, {
    kind: 'cat',
    ownerRef: 'cat:codex-sol',
    evidenceRef: 'task:item:unrelated',
    revision: 1,
  });
  const recoveredActive = await app.inject({
    method: 'GET',
    url: '/api/entrusted-work/owner-reads',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  const recoveredNeedsMe = await app.inject({
    method: 'GET',
    url: '/api/entrusted-work/needs-me',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.deepEqual(recoveredActive.json().coverage, { state: 'complete' });
  assert.deepEqual(recoveredNeedsMe.json().coverage, { state: 'complete' });
  assert.equal(recoveredNeedsMe.json().ownerReads.length, 1);
});
