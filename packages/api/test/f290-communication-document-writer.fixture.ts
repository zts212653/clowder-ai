import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectiveSourceIdentitySchema, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import {
  type InvocationRecord,
  InvocationRegistry,
} from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { getRichBlockBuffer } from '../src/domains/cats/services/agents/invocation/RichBlockBuffer.js';
import { PandocService } from '../src/infrastructure/document/PandocService.js';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.js';
import { registerCallbackDocumentRoutes } from '../src/routes/callback-document-routes.js';
import { fixture } from './f290-communication-current-execution.fixture.js';
import { CAT } from './f290-communication-validation.host.js';

/** Real Service/Connector/Host authority, Fastify auth, Registry and F088 MD renderer; no model calls. */
export async function documentWriterFixture() {
  const f = await fixture();
  // Both real participants are declared before the current continuation. Same-Task home delegation remains explicit.
  const participationRevision = await f.world.declareCats(f.cafe, [CAT, createCatId('opus')], {
    threadId: f.endpoint.id,
  });
  const continued = await f.continueWork(
    'Fixture current execution for document generation and relay',
    participationRevision,
  );
  const dispatch = await f.admission.admit(continued.source, CAT);
  assert.ok(dispatch);
  const currentAuth = await f.authFor(dispatch.messageId);
  const uploadDir = await mkdtemp(join(tmpdir(), 'f290-document-writer-'));
  const previousUploadDir = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = uploadDir;
  const hooks: {
    afterRender?: () => Promise<void>;
    beforeVerify?: (record: InvocationRecord, count: number) => Promise<void>;
  } = {};
  const calls = new Map<string, number>();
  const registry = new InvocationRegistry();
  registry.setCollectiveWorkAuthorityValidator(async (record) => {
    const count = (calls.get(record.invocationId) ?? 0) + 1;
    calls.set(record.invocationId, count);
    await hooks.beforeVerify?.(record, count);
    assert.ok(await f.context.resolvePrivate(record, 'callback'));
  });
  const binding = currentAuth.collectiveWorkBinding;
  assert.ok(binding && currentAuth.originTriggerMessageId);
  const auth = await registry.create(
    f.cafe.ownerUserId,
    CAT,
    f.task.threadId,
    undefined,
    undefined,
    {
      mode: 'collective_work',
      taskId: f.task.id,
      threadId: f.task.threadId,
      executionRevision: binding.executionRevision,
      executionRef: binding.executionRef ?? binding.authorityRef,
      workspaceRoot: join(uploadDir, 'private-workspace'),
      readOnlyRoots: [],
    },
    currentAuth.originTriggerMessageId,
    'unknown',
    undefined,
    undefined,
    binding,
  );
  const scope = {
    userId: f.cafe.ownerUserId,
    taskId: f.task.id,
    executionRevision: binding.executionRevision,
    resultRevision: binding.resultRevision,
  };
  const app = Fastify();
  registerCallbackAuthHook(app, registry);
  const renderer = new PandocService(app.log);
  const broadcasts: unknown[] = [];
  registerCallbackDocumentRoutes(app, {
    registry,
    messageStore: f.messages,
    threadStore: f.threads,
    socketManager: {
      broadcastAgentMessage(message) {
        broadcasts.push(message);
      },
    },
    documentService: {
      async generate(...input) {
        const result = await renderer.generate(...input);
        await hooks.afterRender?.();
        return result;
      },
    },
  });
  const post = (payload: Record<string, unknown>, credentials = auth) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/generate-document',
      headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
      payload,
    });
  const publicAuth = async () => {
    const sourceRef = f.task.entrustedWork?.admission.sourceRefs[0];
    assert.ok(sourceRef && sourceRef.startsWith('message:'));
    const source = await f.messages.getById(sourceRef.slice('message:'.length));
    assert.ok(source);
    const identity = collectiveSourceIdentitySchema.parse(source.source?.meta?.participation);
    return registry.create(
      f.cafe.ownerUserId,
      CAT,
      f.endpoint.id,
      undefined,
      undefined,
      { mode: 'collective_participation' },
      source.id,
      'unknown',
      undefined,
      { kind: 'collective-participation', originTriggerMessageId: source.id, source: identity },
    );
  };
  const relayAuth = async () => {
    const catId = createCatId('opus');
    f.threads.addParticipants(f.task.threadId, [catId]);
    const delegation = (
      await f.messages.appendIdempotent({
        userId: f.cafe.ownerUserId,
        threadId: f.task.threadId,
        catId: CAT,
        mentions: [catId],
        timestamp: Date.now(),
        origin: 'callback',
        content: 'Fixture authenticated owner delegates this same Task',
        idempotencyKey: 'fixture-document-relay',
        extra: {
          isExplicitPost: true,
          collectiveWorkDelegationV1: {
            v: 1,
            taskId: binding.taskId,
            observedRevision: binding.observedRevision,
            resultRevision: binding.resultRevision,
            executionRevision: binding.executionRevision,
            ...(binding.executionRef ? { executionRef: binding.executionRef } : {}),
            ownerCatId: CAT,
            targetCatIds: [catId],
          },
        },
      })
    ).message;
    const input = {
      userId: f.cafe.ownerUserId,
      threadId: f.task.threadId,
      catId,
      originTriggerMessageId: delegation.id,
      ownerAuthProvenance: 'unknown' as const,
    };
    const current = await f.context.resolvePrivate(input, 'admission');
    assert.ok(current);
    const grant = await registry.create(
      f.cafe.ownerUserId,
      catId,
      f.task.threadId,
      undefined,
      undefined,
      {
        mode: 'collective_work',
        taskId: f.task.id,
        threadId: f.task.threadId,
        executionRevision: binding.executionRevision,
        executionRef: binding.executionRef ?? binding.authorityRef,
        workspaceRoot: join(uploadDir, 'relay-workspace'),
        readOnlyRoots: [],
      },
      delegation.id,
      'unknown',
      undefined,
      undefined,
      { ...binding, sourceRef: current.sourceRef, authorityRef: current.work.authorityRef },
    );
    return { ...grant, catId };
  };
  return {
    ...f,
    uploadDir,
    registry,
    app,
    auth,
    scope,
    hooks,
    broadcasts,
    post,
    publicAuth,
    relayAuth,
    close: async () => {
      getRichBlockBuffer().consume(f.task.threadId, CAT, auth.invocationId);
      await app.close();
      await f.world.close();
      if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
      else process.env.UPLOAD_DIR = previousUploadDir;
      await rm(uploadDir, { recursive: true, force: true });
    },
  };
}
