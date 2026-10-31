import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { createContentModificationIntegration } from '../../src/domains/collaborative-content/modification/composition.js';
import { WorkspaceContentReviewService } from '../../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../../src/domains/collaborative-content/workspace-review/store.js';
import { workspaceReviewIdentity } from '../../src/domains/collaborative-content/workspace-review/workspace-review-anchors.js';
import {
  WorkspaceContentSourceError,
  WorkspaceContentSourceService,
} from '../../src/domains/workspace/workspace-content-source.js';
import { registerCallbackContentModificationRoutes } from '../../src/routes/callback-content-modification-routes.js';
import { registerWorkspaceContentReviewRoutes } from '../../src/routes/workspace-content-review-routes.js';
import { createLiveReviewFixture } from './artifact-review-live-fixture.js';

export async function firstFileFixture(t: TestContext, path = 'guide.md', sourceBytes?: string) {
  const root = await mkdtemp(join(tmpdir(), 'f309-first-file-'));
  const bytes = path.endsWith('.ts')
    ? 'export const greeting = "Hello first file";\n'
    : '# Guide\nFirst unique paragraph.\n';
  await writeFile(join(root, path), sourceBytes ?? bytes);
  let access = true;
  let canonicalWorktreeId = 'worktree-a';
  let activeRoot = root;
  let replacementRoot: string | undefined;
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => {
      if (!access) throw new WorkspaceContentSourceError('access_denied');
      return { root: activeRoot, canonicalWorktreeId };
    },
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
    delivery: f.dispatch.delivery,
    changed: () => {},
    onError: (error) => errors.push(error),
  });
  const locator = { worktreeId: 'worktree-a', path };
  // A normal file preview describes its bytes; it has never opened the annotation owner.
  const description = await source.describe({ principal: { userId: 'operator' }, locator });
  const reviewId = workspaceReviewIdentity('operator', description.contentRef);
  const block = (text = path.endsWith('.ts') ? 'Hello first file' : 'First unique paragraph.') => ({
    type: 'context_attachment' as const,
    attachment: {
      v: 1 as const,
      id: 'first-selection',
      kind: 'quote' as const,
      text,
      source: { kind: 'workspace_file' as const, ...locator, revision: description.revision },
    },
  });
  const message = f.messages.append({
    userId: 'operator',
    threadId: f.thread.id,
    from: { kind: 'user', userId: 'operator' },
    mentions: ['codex-astra'],
    timestamp: Date.now(),
    content: 'Please revise this quoted passage.',
    contentBlocks: [block()],
  });
  const taskCount = f.tasks.listByThread(f.thread.id).length;
  const app = Fastify(),
    registry = new InvocationRegistry();
  const auth = await registry.create('operator', 'codex-astra', f.thread.id);
  await registerCallbackContentModificationRoutes(app, {
    text: integration.text,
    receipts: integration.receipts,
    requests: integration.requests,
    sourceDiscussions: integration.sourceDiscussions,
    threads: f.threads,
    registry,
    changed: () => {},
  });
  registerWorkspaceContentReviewRoutes(app, { reviews: files });
  const operationId = randomUUID();
  const takeover = (sourceMessageId = message.id, operation = operationId) =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/content-modification/take-over',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: { sourceMessageId, operationId: operation },
    });
  t.after(async () => {
    await app.close();
    integration.writer.close();
    await f.dispatch.close();
    fileStore.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
    if (replacementRoot) await rm(replacementRoot, { recursive: true, force: true });
  });
  return {
    ...f,
    source,
    files,
    fileStore,
    integration,
    errors,
    app,
    root,
    locator,
    description,
    reviewId,
    message,
    block,
    taskCount,
    auth,
    operationId,
    takeover,
    revoke: () => {
      access = false;
    },
    rebind: async () => {
      replacementRoot = await mkdtemp(join(tmpdir(), 'f309-rebound-file-'));
      await writeFile(join(replacementRoot, path), sourceBytes ?? bytes);
      activeRoot = replacementRoot;
      canonicalWorktreeId = 'worktree-b';
    },
  };
}

export function workspaceQuote(
  id: string,
  text: string,
  comment: string | undefined,
  revision: string | undefined,
  path = 'guide.md',
) {
  return {
    type: 'context_attachment' as const,
    attachment: {
      v: 1 as const,
      id,
      kind: 'quote' as const,
      text,
      ...(comment ? { comment } : {}),
      source: {
        kind: 'workspace_file' as const,
        path,
        worktreeId: 'worktree-a',
        ...(revision ? { revision } : {}),
      },
    },
  };
}
