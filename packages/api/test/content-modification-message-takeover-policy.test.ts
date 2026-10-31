import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { StoredMessage } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { resolveMessageTakeover } from '../src/domains/collaborative-content/modification/message-takeover.js';
import {
  WorkspaceContentSourceError,
  WorkspaceContentSourceService,
} from '../src/domains/workspace/workspace-content-source.js';

test('message takeover reports a display-only MDX file as unsupported instead of source drift', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-message-takeover-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'guide.mdx'), '# MDX guide\n');
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'worktree-a' }),
  });
  const description = await source.describe({
    principal: { userId: 'operator', actor: { kind: 'human', actorId: 'operator' } },
    locator: { worktreeId: 'worktree-a', path: 'guide.mdx' },
  });
  const targetCatId = createCatId('codex-astra');
  const message: StoredMessage = {
    id: 'message-mdx',
    userId: 'operator',
    threadId: 'thread-a',
    catId: null,
    mentions: [targetCatId],
    timestamp: 1,
    deliveryStatus: 'delivered',
    content: 'Please update this display-only MDX passage.',
    contentBlocks: [
      {
        type: 'context_attachment',
        attachment: {
          v: 1,
          id: 'selection-1',
          kind: 'quote',
          text: 'MDX guide',
          source: {
            kind: 'workspace_file',
            worktreeId: 'worktree-a',
            path: 'guide.mdx',
            revision: description.revision,
          },
        },
      },
    ],
  };

  await assert.rejects(
    resolveMessageTakeover(
      {
        messages: { getById: () => message },
        source,
        files: {
          ensureTextReviewFromMessageTakeover: () => Promise.reject(new Error('must reject before review preparation')),
        },
        requests: { forSource: () => [] },
        tasks: { get: () => null },
      },
      { sourceMessageId: message.id, operationId: '11111111-1111-4111-8111-111111111111' },
      { userId: 'operator', threadId: message.threadId, actor: { kind: 'cat', actorId: targetCatId } },
    ),
    (error: unknown) => error instanceof WorkspaceContentSourceError && error.code === 'unsupported_text',
  );
});
