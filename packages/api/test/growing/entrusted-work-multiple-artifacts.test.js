import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { EntrustedWorkLifecycleService } = await import('../../dist/domains/growing/EntrustedWorkLifecycleService.js');
const { EntrustedWorkOwnerReadService } = await import('../../dist/domains/growing/EntrustedWorkOwnerReadService.js');
const { registerEntrustedWorkReadRoutes } = await import('../../dist/routes/entrusted-work-read-routes.js');

const now = 1_788_941_790_979;
const ownerUserId = 'owner-1';
const threadId = 'thread-f310-multiple-artifacts';
const refs = ['file:preparation.md', 'file:feature.md', 'file:showcase.md'];

function command(id, artifactRefs) {
  return {
    task: {
      threadId,
      title: `Entrusted work ${id}`,
      why: 'A real outcome with source-backed business time',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      userId: ownerUserId,
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: [`message:${id}`],
      intendedOutcome: `Complete ${id} using its original materials`,
      idempotencyKey: `entrusted:${id}`,
    },
    closure: { condition: 'The entrusted outcome is complete', expectedSignal: `artifact:${id}:final` },
    time: { businessDeadline: { value: now + 86_400_000, sourceRef: `message:${id}` } },
    artifactRefs,
  };
}

function fixture() {
  const tasks = new TaskStore();
  const lifecycle = new EntrustedWorkLifecycleService(tasks, { now: () => now });
  const reads = [];
  const receipts = [];
  const service = new EntrustedWorkOwnerReadService({
    tasks,
    producerCatalog: {
      async listCurrentReceipts() {
        return receipts;
      },
    },
    artifactReader: {
      async readPreparedArtifact({ artifactRef, taskRevision }) {
        reads.push(artifactRef);
        return {
          artifactRef,
          artifactRevision: '7',
          completenessRef: `${artifactRef}#published:7`,
          previewRef: `${artifactRef}#preview:7`,
          openInWorkspaceRef: `workspace:${artifactRef}:${taskRevision}`,
        };
      },
    },
  });
  return { tasks, lifecycle, service, reads, receipts };
}

async function admit(lifecycle, id, artifactRefs) {
  const result = await lifecycle.admitOrResume(command(id, artifactRefs));
  return result.ownerRef.slice('task:item:'.length);
}

function eligibleReceipt(taskId, id) {
  return {
    producer: {
      producerId: 'f246.approval',
      ownerRef: `approval:${id}`,
      subjectRef: `approval:${id}`,
      revision: 1,
    },
    taskRef: { subjectRef: `task:work:${taskId}`, observedRevision: 1 },
    eligible: true,
    kind: 'judgment',
    reasonCode: 'needs_authorization',
    recommendation: 'Review the original owner decision',
    salience: 'normal',
    action: { actionRef: `approval:${id}:authorize`, expectedProducerRevision: 1 },
    reEvaluateActionRef: `approval:${id}#reevaluate`,
  };
}

describe('F310 reads preserve work with multiple Artifact refs', () => {
  test('Web and cat retain the canonical Task after a legal multi-material update without inventing a primary', async () => {
    const { tasks, lifecycle, service, reads } = fixture();
    const taskId = await admit(lifecycle, 'showcase', ['file:showcase.md']);
    await lifecycle.update({
      taskId,
      expectedRevision: 1,
      artifactRefs: refs,
    });
    const before = structuredClone(await tasks.get(taskId));
    const human = await service.read({ taskId, viewer: { surface: 'human', userId: ownerUserId } });
    const cat = await service.read({
      taskId,
      viewer: { surface: 'cat', userId: ownerUserId, threadId, catId: 'codex-sol' },
    });

    assert.deepEqual(human, cat);
    assert.equal(human.envelope.revision, 2);
    assert.equal(human.brief.current.state, 'todo');
    assert.equal(human.brief.outcome.value, 'Complete showcase using its original materials');
    assert.equal(human.brief.verifiedMilestone.kind, 'time_committed');
    assert.equal(human.timeRefs[0].value, now + 86_400_000);
    assert.equal(human.preparedArtifact, undefined);
    assert.deepEqual(reads, [], 'ambiguous refs must not be turned into an arbitrary primary');
    assert.deepEqual(await tasks.get(taskId), before, 'reads must not repair or delete canonical Task data');
    assert.deepEqual(before.entrustedWork.artifactRefs, [...refs].sort());
  });

  test('one multi-material Task cannot turn the whole Schedule endpoint into a 500 or hide its peers', async (t) => {
    const { tasks, lifecycle, service } = fixture();
    const multipleId = await admit(lifecycle, 'showcase', refs);
    const singleId = await admit(lifecycle, 'video', ['file:video.mp4']);
    const before = structuredClone(await tasks.listByKind('work'));
    const app = Fastify();
    t.after(() => app.close());
    registerEntrustedWorkReadRoutes(app, { service, callbackRegistry: new InvocationRegistry() });

    const response = await app.inject({
      method: 'GET',
      url: '/api/entrusted-work/owner-reads',
      headers: { 'x-cat-cafe-user': ownerUserId },
    });

    assert.equal(response.statusCode, 200);
    const ownerReads = response.json().ownerReads;
    assert.equal(ownerReads.length, 2);
    const multiple = ownerReads.find((read) => read.envelope.ownerRef === `task:item:${multipleId}`);
    const single = ownerReads.find((read) => read.envelope.ownerRef === `task:item:${singleId}`);
    assert.equal(multiple.brief.outcome.value, 'Complete showcase using its original materials');
    assert.equal(multiple.preparedArtifact, undefined);
    assert.equal(single.preparedArtifact.artifactRef, 'file:video.mp4');
    assert.deepEqual(await tasks.listByKind('work'), before);
  });

  test('a linked ambiguous Task cannot suppress a different prepared Needs Me item', async () => {
    const { lifecycle, service, receipts } = fixture();
    const multipleId = await admit(lifecycle, 'showcase', refs);
    const singleId = await admit(lifecycle, 'video', ['file:video.mp4']);
    receipts.push(eligibleReceipt(multipleId, 'showcase'), eligibleReceipt(singleId, 'video'));

    const ownerReads = await service.listNeedsMeForOwner(ownerUserId);

    assert.equal(ownerReads.length, 1);
    assert.equal(ownerReads[0].envelope.ownerRef, `task:item:${singleId}`);
    assert.equal(ownerReads[0].brief.needsMe.state, 'needed');
    assert.equal(ownerReads[0].attentionReceipts[0].producer.ownerRef, 'approval:video');
  });
});
