import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetNewConversationIntentDbForTests,
  clearNewConversationIntent,
  loadNewConversationIntent,
  saveNewConversationIntent,
} from '../new-conversation-intent-store';

const ALICE = 'owner-alice';

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file);
  });
}

afterEach(async () => {
  await clearNewConversationIntent(ALICE).catch(() => undefined);
  await clearNewConversationIntent('owner-bob').catch(() => undefined);
  _resetNewConversationIntentDbForTests();
});

describe('F322 persistent pre-thread intent', () => {
  it('round-trips files, options and a known created thread without a TTL', async () => {
    const file = new File(['hello'], 'brief.md', { type: 'text/markdown' });
    await saveNewConversationIntent({
      ownerUserId: ALICE,
      intent: {
        v: 1,
        createIdempotencyKey: '11111111-1111-4111-8111-111111111111',
        messageIdempotencyKey: '22222222-2222-4222-8222-222222222222',
        projectPath: '/work/cafe',
        preferredCats: ['codex-sol'],
        title: '季度研究计划',
        pinned: true,
        creationStarted: true,
        createdThreadId: 'thread-created',
        messageAccepted: true,
        composerDraftAdmission: { threadId: 'default', expectedRevision: 7 },
      },
      files: [file],
      contextAttachments: [{ v: 1, id: 'ctx-1', kind: 'thread', threadId: 'source-thread', title: 'Source thread' }],
      updatedAt: 42,
    });

    _resetNewConversationIntentDbForTests();
    const restored = await loadNewConversationIntent(ALICE);
    expect(restored).toMatchObject({
      ownerUserId: ALICE,
      intent: {
        projectPath: '/work/cafe',
        preferredCats: ['codex-sol'],
        title: '季度研究计划',
        pinned: true,
        creationStarted: true,
        createdThreadId: 'thread-created',
        messageAccepted: true,
        composerDraftAdmission: { threadId: 'default', expectedRevision: 7 },
      },
      updatedAt: 42,
    });
    expect(restored?.files).toHaveLength(1);
    expect(restored?.files[0]?.name).toBe('brief.md');
    expect(restored?.files[0] ? await readText(restored.files[0]) : null).toBe('hello');
    expect(restored?.contextAttachments).toEqual([
      { v: 1, id: 'ctx-1', kind: 'thread', threadId: 'source-thread', title: 'Source thread' },
    ]);
  });

  it('isolates intents by authenticated owner and clears only the selected owner', async () => {
    const record = (ownerUserId: string, createdThreadId: string) => ({
      ownerUserId,
      intent: {
        v: 1 as const,
        createIdempotencyKey: '11111111-1111-4111-8111-111111111111',
        messageIdempotencyKey: '22222222-2222-4222-8222-222222222222',
        preferredCats: [],
        creationStarted: true,
        createdThreadId,
      },
      files: [],
      contextAttachments: [],
      updatedAt: 42,
    });
    await saveNewConversationIntent(record(ALICE, 'thread-alice'));
    await saveNewConversationIntent(record('owner-bob', 'thread-bob'));

    await clearNewConversationIntent(ALICE);
    expect(await loadNewConversationIntent(ALICE)).toBeNull();
    expect(await loadNewConversationIntent('owner-bob')).toMatchObject({
      intent: { createdThreadId: 'thread-bob' },
    });
  });
});
