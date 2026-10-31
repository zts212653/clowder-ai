import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { assembleContext } from '../src/domains/cats/services/context/ContextAssembler.js';
import { DeliveryCursorStore } from '../src/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import type { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { canViewMessage } from '../src/domains/cats/services/stores/visibility.js';
import { ArtifactReviewService } from '../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { createContentModificationIntegration } from '../src/domains/collaborative-content/modification/composition.js';
import { ContentTextModificationService } from '../src/domains/collaborative-content/modification/text/text-service.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { ArtifactReviewReturnDispatcher } from '../src/domains/growing/ArtifactReviewReturnDispatcher.js';
import { PublishedMediaAccess } from '../src/domains/video-studio/content-owner/published-media-access.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { registerCallbackContentModificationRoutes } from '../src/routes/callback-content-modification-routes.js';
import { callbacksRoutes } from '../src/routes/callbacks.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';
import './helpers/setup-cat-registry.js';

const targetCatId = 'codex-astra';
const outsiderCatId = 'opus55';

for (const visibility of ['public', 'whisper'] as const) {
  test(`${visibility} Human takeover keeps its initial Host carrier audience and identity through restart and settlement`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `f309-initial-${visibility}-`));
    await writeFile(join(root, 'guide.md'), '# Guide\nOne editable paragraph.\n');
    const source = new WorkspaceContentSourceService({
      ownerUserId: 'operator',
      resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'worktree-a' }),
    });
    const live = await createLiveReviewFixture(root, 'image/png', undefined, source);
    let activeStore: ArtifactReviewStore | undefined = live.store;
    const fileStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
    const files = new WorkspaceContentReviewService({ source, store: fileStore });
    const errors: unknown[] = [];
    const integration = createContentModificationIntegration({
      dataDir: root,
      source,
      files,
      artifacts: live,
      tasks: live.tasks,
      messages: live.messages,
      changed: () => {},
      onError: (error) => errors.push(error),
    });
    const takeoverApp = Fastify();
    const registry = new InvocationRegistry();
    await registerCallbackContentModificationRoutes(takeoverApp, {
      text: integration.text,
      receipts: integration.receipts,
      requests: integration.requests,
      sourceDiscussions: integration.sourceDiscussions,
      threads: live.threads,
      registry,
      changed: () => {},
    });
    t.after(async () => {
      await takeoverApp.close();
      await live.dispatch.close();
      integration.writer.close();
      fileStore.close();
      activeStore?.close();
      console.log(`retained owned review data: ${root}`);
    });

    const opened = await files.prepare({
      principal: live.human,
      locator: { worktreeId: 'worktree-a', path: 'guide.md' },
      operationId: `open-${visibility}`,
    });
    const sourceMessage = live.messages.append({
      userId: 'operator',
      threadId: live.thread.id,
      from: { kind: 'user', userId: 'operator' },
      mentions: [targetCatId],
      timestamp: Date.now(),
      content: 'Please revise the selected heading.',
      contentBlocks: [quote(opened.review.source.revision)],
      ...(visibility === 'whisper' ? { visibility, whisperTo: [createCatId(targetCatId)] } : {}),
    });

    const queued = live.store.returns.queued.bind(live.store.returns);
    let crashBeforeOutboxMark = true;
    live.store.returns.queued = (receiptRef, messageId) => {
      if (crashBeforeOutboxMark) {
        crashBeforeOutboxMark = false;
        throw new Error('simulated crash before return outbox mark');
      }
      queued(receiptRef, messageId);
    };
    const auth = await registry.create('operator', targetCatId, live.thread.id);
    const takeover = await takeoverApp.inject({
      method: 'POST',
      url: '/api/callbacks/content-modification/take-over',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { sourceMessageId: sourceMessage.id, operationId: randomUUID() },
    });
    assert.equal(takeover.statusCode, 200, takeover.body);
    const record = live.store.requests.get(takeover.json().record.requestId, 'operator');
    assert.ok(record?.progress.task && record.progress.review);
    const pending = live.store.returns.get(record.progress.review.receiptRef);
    assert.ok(pending?.kind === 'request_text_edit');
    assert.equal(pending.state, 'pending');
    assert.deepEqual(
      record.progress.sourceVisibility,
      visibility === 'whisper' ? { visibility, whisperTo: [targetCatId] } : { visibility: 'public' },
    );
    const admitted = await waitForInitialCarrier(live.messages, live.thread.id, record.requestId, () =>
      errors
        .flatMap((error) => (error instanceof AggregateError ? error.errors : [error]))
        .map((error) => String(error instanceof Error ? error.stack : error))
        .join('\n'),
    );
    assert.ok(admitted);
    assert.equal(admitted.lifecycle?.kind, 'input');
    assert.equal(Object.hasOwn(admitted, 'queueCustody'), false);

    live.store.close();
    activeStore = undefined;
    const restartedStore = new ArtifactReviewStore(join(root, 'collaborative-content', 'artifact-reviews.sqlite'));
    activeStore = restartedStore;
    const restartedText = new ContentTextModificationService({
      store: restartedStore,
      access: new PublishedMediaAccess({ tasks: live.tasks, threads: live.threads }),
      source,
      messages: live.messages,
      executionDirectory: join(root, 'restarted-text-execution'),
    });
    const restartedDispatcher = new ArtifactReviewReturnDispatcher({
      reviews: new ArtifactReviewService({ store: restartedStore, media: live.media }),
      store: restartedStore,
      delivery: live.dispatch.delivery,
      text: restartedText,
      invalidate: () => {},
      emit: () => {},
    });
    await restartedDispatcher.drain();

    const carrier = initialCarrier(live.messages, live.thread.id, record.requestId);
    assert.ok(carrier);
    assert.equal(carrier.lifecycle?.kind, 'input');
    assert.equal(carrier.id, admitted.id, 'restart replay reuses the original durable Queue carrier');
    assert.equal(
      live.messages
        .getByThread(live.thread.id, 100, 'operator', { includeQueuedUserMessages: true })
        .filter((message) => message.source?.meta?.requestId === record.requestId).length,
      1,
    );
    assert.equal(carrier.visibility ?? 'public', visibility);
    assert.deepEqual(carrier.whisperTo ?? [], visibility === 'whisper' ? [targetCatId] : []);
    assert.deepEqual(carrier.source, {
      connector: 'content-review',
      label: 'Host 作品修改请求：原任务续办',
      icon: 'cat-cafe',
      meta: {
        v: 1,
        kind: 'request_text_edit',
        requestId: record.requestId,
        sourceMessageId: sourceMessage.id,
        targetCatId,
        taskId: record.progress.task.taskId,
        expectedTaskRevision: record.progress.task.revision,
        requestReceiptRef: record.progress.review.receiptRef,
      },
    });

    const childId = await live.dispatch.waitForAwakening(carrier.id);
    assert.equal(live.dispatch.turns.get(childId)?.parentInvocationId, live.starts[0]?.parentInvocationId);
    // The controlled provider settles its canonical response; no second custody
    // coordinator is allowed to synthesize an independent delivery verdict.
    await live.dispatch.close();
    assert.equal(live.messages.getById(carrier.id)?.deliveryStatus, 'delivered');

    live.threads.updateThinkingMode(live.thread.id, 'play');
    const contextApp = Fastify();
    t.after(() => contextApp.close());
    await contextApp.register(callbacksRoutes, {
      registry,
      messageStore: live.messages,
      threadStore: live.threads,
      deliveryCursorStore: new DeliveryCursorStore(),
      socketManager: { broadcastAgentMessage() {}, emitToUser() {} },
      evidenceStore: { search: async () => [] },
      reflectionService: { reflect: async () => '' },
      markerQueue: { submit: async () => ({}), list: async () => [] },
    });
    const outsider = await readAs(contextApp, registry, live.thread.id, outsiderCatId);
    if (visibility === 'public') {
      assertHostCarrier(outsider.history, carrier.id);
      assertHostCarrier(outsider.unread, carrier.id);
    } else {
      assert.ok(!outsider.history.some((message) => message.id === carrier.id));
      assert.ok(!outsider.unread.some((message) => message.id === carrier.id));
      assert.equal(canViewMessage(carrier, { type: 'cat', catId: outsiderCatId }), false);
    }
    const target = await readAs(contextApp, registry, live.thread.id, targetCatId);
    assertHostCarrier(target.history, carrier.id);
    assertHostCarrier(target.unread, carrier.id);
    assert.match(promptFor(live.messages, live.thread.id, targetCatId), /Host 作品修改请求：原任务续办/);
    assert.doesNotMatch(promptFor(live.messages, live.thread.id, targetCatId), /co-creator.*作品修改请求/);
    if (visibility === 'whisper')
      assert.doesNotMatch(promptFor(live.messages, live.thread.id, outsiderCatId), /作品修改请求：原任务续办/);
    assert.equal(errors.length, 1, 'only the injected pre-outbox-mark crash is reported');
  });
}

function initialCarrier(messages: MessageStore, threadId: string, requestId: string) {
  return messages
    .getByThread(threadId, 100, 'operator', { includeQueuedUserMessages: true })
    .find((message) => message.source?.meta?.requestId === requestId);
}

async function waitForInitialCarrier(
  messages: MessageStore,
  threadId: string,
  requestId: string,
  failure: () => string,
) {
  const deadline = Date.now() + 2000;
  for (;;) {
    const carrier = initialCarrier(messages, threadId, requestId);
    if (carrier) return carrier;
    if (Date.now() >= deadline) assert.fail(`Review outbox did not reach common durable send: ${failure()}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function readAs(app: ReturnType<typeof Fastify>, registry: InvocationRegistry, threadId: string, catId: string) {
  const auth = await registry.create('operator', catId, threadId);
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const unread = await app.inject({
    method: 'GET',
    url: '/api/callbacks/thread-context?responseMode=full&readIntent=unread',
    headers,
  });
  assert.equal(unread.statusCode, 200, unread.body);
  const history = await app.inject({ method: 'GET', url: '/api/callbacks/thread-context?responseMode=full', headers });
  assert.equal(history.statusCode, 200, history.body);
  return { history: history.json().messages, unread: unread.json().messages } as {
    history: { id: string; speaker: string }[];
    unread: { id: string; speaker: string }[];
  };
}

function assertHostCarrier(messages: { id: string; speaker: string }[], messageId: string) {
  assert.equal(messages.find((message) => message.id === messageId)?.speaker, 'Host 作品修改请求：原任务续办');
}

function promptFor(messages: MessageStore, threadId: string, catId: string) {
  const visible = messages
    .getByThread(threadId, 100, 'operator')
    .filter((message) => canViewMessage(message, { type: 'cat', catId }));
  return assembleContext(visible, { maxTotalTokens: 20_000 }).contextText;
}

function quote(revision: string) {
  return {
    type: 'context_attachment' as const,
    attachment: {
      v: 1 as const,
      id: 'selection-1',
      kind: 'quote' as const,
      text: 'Guide',
      source: { kind: 'workspace_file' as const, path: 'guide.md', worktreeId: 'worktree-a', revision },
    },
  };
}
