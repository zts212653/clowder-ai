import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import Fastify from 'fastify';
import type { InvocationRecord } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { getRichBlockBuffer } from '../src/domains/cats/services/agents/invocation/RichBlockBuffer.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { F232PreparedArtifactReader } from '../src/domains/growing/F232PreparedArtifactReader.js';
import { F290CollectiveWorkResultProducerAdapter } from '../src/domains/growing/F290CollectiveWorkResultProducerAdapter.js';
import { CollectiveCurrentContext } from '../src/domains/plugin/builtin-runtime/collective-current-context.js';
import { readCollectivePreparedResultArtifact } from '../src/domains/plugin/builtin-runtime/collective-prepared-result.js';
import { CollectiveWorkArtifactReader } from '../src/domains/plugin/builtin-runtime/collective-work/collective-work-artifact-read.js';
import { callbacksRoutes } from '../src/routes/callbacks.js';
import { documentWriterFixture } from './f290-communication-document-writer.fixture.js';

type Credentials = Pick<InvocationRecord, 'invocationId' | 'callbackToken'>;
export const documentPayload = {
  markdown: '# Prepared guide\n\nOne immutable body.\n',
  format: 'md',
  baseName: 'guide',
};

/** Production document/post-message/CAS/read/reply/producer consumers; OAuth/model/socket sinks are fixtures. */
export async function duplicatePublicationFixture() {
  const f = await documentWriterFixture();
  // Admit the same-Task named relay before Artifact CAS changes the current Task revision.
  const relay = await f.relayAuth();
  const turns = new InMemoryTurnExecutionStore();
  const posts = Fastify();
  const unusedMemory = new Proxy(
    {},
    {
      get() {
        throw new Error('This publication test must not invoke memory services');
      },
    },
  );
  await posts.register(callbacksRoutes, {
    registry: f.registry,
    messageStore: f.messages,
    threadStore: f.threads,
    taskStore: f.tasks,
    turnExecutionStore: turns,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} } as never,
    evidenceStore: unusedMemory as never,
    markerQueue: unusedMemory as never,
    reflectionService: unusedMemory as never,
  });
  const artifacts = new F232PreparedArtifactReader({ messages: f.messages });
  const contentReader = new CollectiveWorkArtifactReader(f.messages, f.uploadDir);
  const context = new CollectiveCurrentContext({
    connector: () => f.cafe.connector,
    workAuthority: f.authority,
    messageStore: f.messages,
    threadStore: f.threads,
    artifactReader: artifacts,
    artifactUploadDir: f.uploadDir,
  });
  const adapter = new F290CollectiveWorkResultProducerAdapter({
    connector: () => f.cafe.connector,
    tasks: f.tasks,
    messages: f.messages,
    artifacts,
  });
  const record = async (credentials: Credentials = f.auth) => {
    const verified = await f.registry.verify(credentials.invocationId, credentials.callbackToken);
    assert.ok(verified.ok, 'real callback Registry must admit the current Task execution');
    // The existing verifier's explicit scripted-turn map consumes the actual authenticated Registry ID.
    if (!f.world.turns.has(verified.record.invocationId))
      f.world.turns.set(verified.record.invocationId, {
        catId: verified.record.catId,
        status: 'running',
      });
    return verified.record;
  };
  const inject = (url: string, payload: Record<string, unknown>, credentials: Credentials) =>
    posts.inject({
      method: 'POST',
      url,
      headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
      payload,
    });
  let publication = 0;
  const publish = async (credentials: Credentials = f.auth, markdown = documentPayload.markdown) => {
    const auth = await record(credentials);
    assert.ok(auth.originTriggerMessageId);
    if (!turns.get(auth.invocationId))
      turns.createRunning({
        invocationId: auth.invocationId,
        parentInvocationId: auth.parentInvocationId ?? auth.invocationId,
        userId: auth.userId,
        threadId: auth.threadId,
        catId: auth.catId,
        executionKind: 'ordinary',
        startedAt: Date.now(),
        causal: { triggerMessageId: auth.originTriggerMessageId },
      });
    const generated = await f.post({ ...documentPayload, markdown }, credentials);
    assert.equal(generated.statusCode, 200, generated.body);
    assert.equal(generated.json<{ status: string }>().status, 'ok');
    const posted = await inject(
      '/api/callbacks/post-message',
      {
        content: `Authenticated generated document publication ${++publication}`,
        clientMessageId: `duplicate-publication:${publication}`,
      },
      credentials,
    );
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(posted.json<{ status: string }>().status, 'ok');
    return generated.json<{ url: string }>().url;
  };
  const register = async (artifactRef: string, credentials: Credentials = f.auth) => {
    const task = await f.tasks.get(f.task.id);
    assert.ok(task?.entrustedWork);
    const registered = await inject(
      '/api/callbacks/update-entrusted-work',
      {
        taskId: task.id,
        expectedRevision: task.entrustedWork.revision,
        artifactRefs: [artifactRef],
      },
      credentials,
    );
    assert.equal(registered.statusCode, 200, registered.body);
    assert.deepEqual((await f.tasks.get(task.id))?.entrustedWork?.artifactRefs, [artifactRef]);
  };
  const prepared = async (artifactRef: string) => {
    const task = await f.tasks.get(f.task.id);
    assert.ok(task?.entrustedWork);
    return artifacts.readPreparedArtifact({
      artifactRef,
      taskThreadId: task.threadId,
      taskSubjectRef: `task:work:${task.id}`,
      taskOwnerRef: `task:item:${task.id}`,
      taskRevision: task.entrustedWork.revision,
      ownerUserId: f.cafe.ownerUserId,
      viewer: { surface: 'human', userId: f.cafe.ownerUserId },
    });
  };
  const sealed = async (credentials: Credentials = f.auth) => {
    const auth = await record(credentials);
    const binding = await context.resolvePrivate(auth, 'callback');
    assert.ok(binding);
    return readCollectivePreparedResultArtifact(binding, auth, artifacts, contentReader);
  };
  const returnResult = async (credentials: Credentials = f.auth) => {
    const auth = await record(credentials);
    const current = await context.current(auth);
    return context.reply(auth, current.returnRef, current.replyOperationRef, 'The registered guide is ready');
  };
  const receipt = () =>
    adapter.readCurrentReceipt({
      ownerUserId: f.cafe.ownerUserId,
      producerSubjectRef: `collective-result:${f.cafe.connectionId}:${f.work.workId}`,
    });
  const filePublications = async (artifactRef: string) =>
    (await f.messages.getByThread(f.task.threadId, 100, f.cafe.ownerUserId)).filter((message) =>
      message.extra?.rich?.blocks.some((block) => block.kind === 'file' && block.url === artifactRef),
    );
  const resultPublications = () =>
    f.cafe.connector.withAssignedWorkAuthority(
      f.cafe.connectionId,
      f.work.workId,
      async (scope) => scope.resultPublications,
    );
  return {
    ...f,
    artifacts,
    adapter,
    context,
    record,
    publish,
    register,
    prepared,
    sealed,
    returnResult,
    receipt,
    filePublications,
    resultPublications,
    relayAuth: async () => relay,
    removeBytes: (artifactRef: string) => unlink(join(f.uploadDir, basename(artifactRef))),
    close: async () => {
      getRichBlockBuffer().consume(f.task.threadId, relay.catId, relay.invocationId);
      await posts.close();
      await f.close();
    },
  };
}
