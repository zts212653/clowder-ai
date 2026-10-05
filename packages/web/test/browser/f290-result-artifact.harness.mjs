import { EntrustedWorkOwnerReadService } from '../../../api/dist/domains/growing/EntrustedWorkOwnerReadService.js';
import { F232PreparedArtifactReader } from '../../../api/dist/domains/growing/F232PreparedArtifactReader.js';
import { F290CollectiveWorkResultProducerAdapter } from '../../../api/dist/domains/growing/F290CollectiveWorkResultProducerAdapter.js';
import { NeedsMeProducerCatalog } from '../../../api/dist/domains/growing/NeedsMeProducerCatalog.js';

const passiveProducer = (producerId) => ({
  producerId,
  async listCurrentReceipts() {
    return [];
  },
  async readCurrentReceipt() {
    return null;
  },
  async reEvaluate() {
    return { state: 'retired', producerRevision: null };
  },
});

/** Compose the real prepared-Artifact reader and F290 Needs Me producer for owner browser journeys. */
export function createNativeOwnerResultArtifacts({ connector, tasks, messages, userId, cat }) {
  const publications = new F232PreparedArtifactReader({ messages });
  const artifacts = [];
  const resultProducer = new F290CollectiveWorkResultProducerAdapter({
    connector: () => connector,
    tasks,
    messages,
    artifacts: publications,
  });
  const ownerReads = new EntrustedWorkOwnerReadService({
    tasks,
    artifactReader: publications,
    producerCatalog: new NeedsMeProducerCatalog([
      passiveProducer('f246.approval'),
      passiveProducer('f292.repair'),
      passiveProducer('f306.runtime_interaction'),
      passiveProducer('f309.content_review'),
      resultProducer,
    ]),
  });

  return {
    publications,
    ownerReads,
    listArtifacts() {
      return structuredClone(artifacts);
    },
    async attachToTask(taskId, artifactRef = `/uploads/f290-result-${taskId}.md`) {
      const task = await tasks.get(taskId);
      if (!task?.entrustedWork) throw new Error('Collective result Task is unavailable');
      const timestamp = Date.now();
      const publication = messages.append({
        userId,
        catId: cat.id,
        threadId: task.threadId,
        mentions: [],
        timestamp,
        content: '已准备好供负责人判断的结果产物。',
        extra: {
          rich: {
            v: 1,
            blocks: [
              {
                kind: 'file',
                v: 1,
                id: `collective-result-${taskId}`,
                fileName: 'Collective result.md',
                url: artifactRef,
                mimeType: 'text/markdown',
              },
            ],
          },
        },
      });
      artifacts.push({
        type: 'file',
        name: 'Collective result.md',
        catId: cat.id,
        createdAt: timestamp,
        sourceMessageId: publication.id,
        url: artifactRef,
        threadId: task.threadId,
        threadTitle: 'Collective result owner',
      });
      const updated = await tasks.updateEntrustedWork(taskId, {
        expectedRevision: task.entrustedWork.revision,
        artifactRefs: [artifactRef],
      });
      if (updated.kind !== 'updated') {
        throw new Error(`Collective result Artifact update failed: ${updated.kind}`);
      }
      return updated.task;
    },
    async snapshotForTask(task) {
      const artifactRef =
        task.entrustedWork?.artifactRefs.length === 1 ? task.entrustedWork.artifactRefs[0] : undefined;
      const artifact = artifactRef
        ? await publications.readPreparedArtifact({
            artifactRef,
            taskThreadId: task.threadId,
            taskSubjectRef: `task:work:${task.id}`,
            taskOwnerRef: `task:item:${task.id}`,
            taskRevision: task.entrustedWork.revision,
            ownerUserId: userId,
            viewer: { surface: 'cat', userId, threadId: task.threadId, catId: cat.id },
          })
        : null;
      return artifact
        ? { taskRef: `task:work:${task.id}`, taskRevision: task.entrustedWork.revision, ...artifact }
        : undefined;
    },
  };
}

/** Serve the real owner-read and Artifact projections needed by the Host Workspace. */
export function registerNativeOwnerResultArtifactRoutes(app, resultArtifacts) {
  const { ownerReads } = resultArtifacts;
  app.get('/api/entrusted-work/owner-reads', async (request, reply) =>
    request.sessionUserId
      ? { ownerReads: await ownerReads.listForOwner(request.sessionUserId) }
      : reply.code(401).send({ error: 'fixture session required' }),
  );
  app.get('/api/entrusted-work/needs-me', async (request, reply) =>
    request.sessionUserId
      ? { ownerReads: await ownerReads.listNeedsMeForOwner(request.sessionUserId) }
      : reply.code(401).send({ error: 'fixture session required' }),
  );
  app.get('/api/artifacts', async (request, reply) =>
    request.sessionUserId
      ? { artifacts: resultArtifacts.listArtifacts(), total: resultArtifacts.listArtifacts().length }
      : reply.code(401).send({ error: 'fixture session required' }),
  );
  app.get('/api/threads/:threadId/artifacts', async (request, reply) => {
    if (!request.sessionUserId) return reply.code(401).send({ error: 'fixture session required' });
    return {
      threadId: request.params.threadId,
      artifacts: resultArtifacts.listArtifacts().filter((artifact) => artifact.threadId === request.params.threadId),
    };
  });
  app.get('/uploads/:fileName', async (request, reply) => {
    const artifact = resultArtifacts
      .listArtifacts()
      .find((candidate) => candidate.url === `/uploads/${request.params.fileName}`);
    return artifact
      ? reply.type('text/markdown').send('# Prepared Collective result\n\nThe owner-backed result is ready to review.')
      : reply.code(404).send({ error: 'Artifact not found' });
  });
}
