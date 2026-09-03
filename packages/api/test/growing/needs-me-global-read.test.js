import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { EntrustedWorkOwnerReadService } = await import('../../dist/domains/growing/EntrustedWorkOwnerReadService.js');
const { F306NeedsMeProducerAdapter } = await import('../../dist/domains/growing/NeedsMeProducerAdapter.js');
const { NeedsMeProducerCatalog } = await import('../../dist/domains/growing/NeedsMeProducerCatalog.js');
const { registerEntrustedWorkReadRoutes } = await import('../../dist/routes/entrusted-work-read-routes.js');

const now = 1_788_180_000_000;

function entrustedTask(id, revision = 7) {
  return {
    id,
    threadId: 'thread-f310',
    title: 'Prepare tomorrow presentation',
    why: 'Explicitly entrusted',
    status: 'doing',
    createdBy: 'codex-sol',
    ownerCatId: 'codex-sol',
    userId: 'owner-1',
    kind: 'work',
    subjectKey: `entrusted:${id}`,
    createdAt: now,
    updatedAt: now,
    entrustedWork: {
      revision,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: ['message:source-1'],
        idempotencyKey: `entrusted:${id}`,
        receiptRef: `task:receipt:${id}`,
        admittedAt: now,
      },
      intendedOutcome: 'A reviewable presentation is ready',
      time: {},
      artifactRefs: ['artifact:ppt:tomorrows-ppt'],
      closure: {
        condition: 'The final presentation is reviewable',
        expectedSignal: 'artifact:final-presentation',
        state: 'open',
        evidenceRefs: [],
      },
    },
  };
}

function runtimeInteraction(id, taskRef) {
  return {
    request: {
      version: 1,
      interactionId: id,
      kind: 'question',
      title: 'Choose the visual direction',
      createdAt: now,
      owner: { userId: 'owner-1', catId: 'codex-sol', threadId: 'thread-f310', invocationId: 'inv-1' },
      provider: {
        providerId: 'codex',
        method: 'item/tool/requestUserInput',
        requestId: 1,
      },
      questions: [{ id: 'direction', header: 'Direction', question: 'Which direction?' }],
      ...(taskRef ? { entrustedWorkTaskRef: taskRef } : {}),
    },
    status: 'pending',
    hostEpoch: 'host-1',
    updatedAt: now + 1,
    cardRef: { threadId: 'thread-f310', messageId: `message-${id}`, blockId: `block-${id}` },
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

function catalogWith(primary) {
  const byId = {
    'f246.approval': emptyAdapter('f246.approval'),
    'f292.repair': emptyAdapter('f292.repair'),
    'f306.runtime_interaction': emptyAdapter('f306.runtime_interaction'),
    [primary.producerId]: primary,
  };
  return new NeedsMeProducerCatalog(Object.values(byId));
}

function artifactReader() {
  return {
    async readPreparedArtifact({ artifactRef, taskRevision }) {
      return {
        artifactRef,
        artifactRevision: '7',
        completenessRef: `${artifactRef}#available:7`,
        previewRef: `${artifactRef}#preview:7`,
        openInWorkspaceRef: `workspace:${artifactRef}:${taskRevision}`,
      };
    },
  };
}

describe('F310 global Needs Me owner read', () => {
  test('F306 enumerates only records carrying their own typed Task link', async () => {
    const linked = runtimeInteraction('linked', {
      subjectRef: 'task:work:ppt',
      observedRevision: 7,
    });
    const unlinked = runtimeInteraction('unlinked');
    const records = new Map([
      ['linked', linked],
      ['unlinked', unlinked],
    ]);
    const adapter = new F306NeedsMeProducerAdapter({
      async get(id) {
        return structuredClone(records.get(id) ?? null);
      },
      async listPendingByUser() {
        return [structuredClone(linked), structuredClone(unlinked)];
      },
    });

    const receipts = await adapter.listCurrentReceipts('owner-1');

    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].producer.subjectRef, 'linked');
    assert.deepEqual(receipts[0].taskRef, {
      subjectRef: 'task:work:ppt',
      observedRevision: 7,
    });
    assert.deepEqual(
      await adapter.readCurrentReceipt({ ownerUserId: 'owner-1', producerSubjectRef: 'linked' }),
      receipts[0],
    );
  });

  test('global projection includes only current eligible producer links and exposes no caller attachment input', async () => {
    const tasks = new Map([
      ['ppt', entrustedTask('ppt', 7)],
      ['stale', entrustedTask('stale', 8)],
    ]);
    const receipts = [
      {
        eligible: true,
        producer: {
          producerId: 'f306.runtime_interaction',
          ownerRef: 'linked',
          subjectRef: 'linked',
          revision: now + 1,
        },
        taskRef: { subjectRef: 'task:work:ppt', observedRevision: 7 },
        kind: 'judgment',
        reasonCode: 'runtime_interaction:question',
        recommendation: 'Choose the visual direction',
        salience: 'normal',
        action: { actionRef: 'message:thread-f310:message-linked#block-linked', expectedProducerRevision: now + 1 },
        reEvaluateActionRef: 'linked#reevaluate',
      },
      {
        eligible: true,
        producer: {
          producerId: 'f306.runtime_interaction',
          ownerRef: 'stale',
          subjectRef: 'stale',
          revision: now + 2,
        },
        taskRef: { subjectRef: 'task:work:stale', observedRevision: 7 },
        kind: 'judgment',
        reasonCode: 'runtime_interaction:question',
        recommendation: 'This stale action must be inert',
        salience: 'normal',
        action: { actionRef: 'message:thread-f310:message-stale#block-stale', expectedProducerRevision: now + 2 },
        reEvaluateActionRef: 'stale#reevaluate',
      },
    ];
    const primary = {
      producerId: 'f306.runtime_interaction',
      async listCurrentReceipts() {
        return structuredClone(receipts);
      },
      async readCurrentReceipt({ producerSubjectRef }) {
        return structuredClone(receipts.find((receipt) => receipt.producer.subjectRef === producerSubjectRef) ?? null);
      },
    };
    const service = new EntrustedWorkOwnerReadService({
      tasks: {
        async get(id) {
          return structuredClone(tasks.get(id) ?? null);
        },
        async listByKind() {
          return [...tasks.values()].map((task) => structuredClone(task));
        },
      },
      producerCatalog: catalogWith(primary),
      artifactReader: artifactReader(),
    });
    const app = Fastify();
    registerEntrustedWorkReadRoutes(app, { service, callbackRegistry: new InvocationRegistry() });

    const response = await app.inject({
      method: 'GET',
      url: '/api/entrusted-work/needs-me',
      headers: { 'x-cat-cafe-user': 'owner-1' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ownerReads.length, 1);
    assert.equal(response.json().ownerReads[0].envelope.subjectRef, 'task:work:ppt');
    assert.equal(response.json().ownerReads[0].attentionReceipts.length, 1);
    assert.equal(response.json().ownerReads[0].attentionReceipts[0].producer.subjectRef, 'linked');

    const injected = await app.inject({
      method: 'GET',
      url: `/api/entrusted-work/ppt/owner-read?producerSubjects=${encodeURIComponent(
        JSON.stringify([{ producerId: 'f306.runtime_interaction', subjectRef: 'unlinked' }]),
      )}`,
      headers: { 'x-cat-cafe-user': 'owner-1' },
    });
    assert.equal(injected.statusCode, 400);
  });
});
