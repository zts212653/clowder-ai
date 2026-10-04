import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { createContentModificationIntegration } from '../../src/domains/collaborative-content/modification/composition.js';
import { modificationRequestId } from '../../src/domains/collaborative-content/modification/journal.js';
import { WorkspaceContentReviewService } from '../../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../../src/domains/workspace/workspace-content-source.js';
import { registerCallbackContentModificationRoutes } from '../../src/routes/callback-content-modification-routes.js';
import { registerContentModificationRoutes } from '../../src/routes/content-modification-routes.js';
import { createLiveReviewFixture } from './artifact-review-live-fixture.js';

export async function cancellationFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'f309-cancel-'));
  await writeFile(join(root, 'guide.md'), 'The old text.');
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
  });
  const f = await createLiveReviewFixture(root, 'image/png', undefined, source);
  const fileStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
  const files = new WorkspaceContentReviewService({ store: fileStore, source });
  const errors: unknown[] = [];
  const integration = createContentModificationIntegration({
    dataDir: root,
    source,
    files,
    artifacts: f,
    tasks: f.tasks,
    messages: f.messages,
    turnExecutions: f.dispatch.turns,
    queue: f.queue,
    changed: () => {},
    onError: (error) => errors.push(error),
  });
  const opened = await files.prepare({
    principal: f.human,
    locator: { worktreeId: 'work', path: 'guide.md' },
    operationId: 'open',
  });
  const payload = {
    operationId: randomUUID(),
    targetCatId: 'codex-astra',
    threadId: f.thread.id,
    intent: { body: '修改用词' },
    source: {
      kind: 'workspace' as const,
      locator: { worktreeId: 'work', path: 'guide.md' },
      reviewId: opened.review.reviewId,
      expectedReviewRevision: opened.review.revision,
      expectedSourceRevision: opened.review.source.revision,
    },
  };
  const app = Fastify();
  registerContentModificationRoutes(app, integration);
  const registry = new InvocationRegistry(),
    actor = await registry.create('operator', 'codex-astra', f.thread.id);
  await registerCallbackContentModificationRoutes(app, {
    text: integration.text,
    requests: integration.requests,
    sourceDiscussions: integration.sourceDiscussions,
    threads: f.threads,
    registry,
    changed: () => {},
  });
  const requestId = modificationRequestId('operator', payload.operationId);
  const cancel = (id = requestId, headers = { 'x-cat-cafe-user': 'operator' }) =>
    app.inject({ method: 'POST', url: `/api/content-modifications/${id}/cancel`, headers, payload: {} });
  t.after(async () => {
    await app.close();
    integration.writer.close();
    await f.dispatch.close();
    fileStore.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const catRead = (id = requestId, options: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/content-modification/read',
      headers: { 'x-invocation-id': actor.invocationId, 'x-callback-token': actor.callbackToken },
      payload: { ...options, requestId: id },
    });
  return { ...f, integration, app, requestId, payload, cancel, catRead, root, errors };
}
