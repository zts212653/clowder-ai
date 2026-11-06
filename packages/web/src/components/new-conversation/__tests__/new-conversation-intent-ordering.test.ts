// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  _resetNewConversationIntentDbForTests,
  clearNewConversationIntent,
  loadNewConversationIntent,
  saveNewConversationIntent,
} from '../new-conversation-intent-store';

const ALICE = 'ordering-alice';
const BOB = 'ordering-bob';

function record(ownerUserId: string, files: File[] = []) {
  return {
    ownerUserId,
    intent: {
      v: 1 as const,
      createIdempotencyKey: '11111111-1111-4111-8111-111111111111',
      messageIdempotencyKey: '22222222-2222-4222-8222-222222222222',
      preferredCats: [],
      creationStarted: false,
    },
    files,
    contextAttachments: [],
    updatedAt: 42,
  };
}

afterEach(async () => {
  await clearNewConversationIntent(ALICE);
  await clearNewConversationIntent(BOB);
  _resetNewConversationIntentDbForTests();
});

it('loads an earlier pending image save without blocking another owner', async () => {
  await saveNewConversationIntent(record(ALICE));
  let releaseBytes: (bytes: ArrayBuffer) => void = () => {};
  const bytes = new Promise<ArrayBuffer>((resolve) => (releaseBytes = resolve));
  const read = vi.fn(() => bytes);
  const file = new File(['pending'], 'pending.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  const saving = saveNewConversationIntent(record(ALICE, [file]));
  const restoring = loadNewConversationIntent(ALICE);

  // A completed transaction for B also lets an incorrectly eager read of A finish.
  await saveNewConversationIntent(record(BOB));
  releaseBytes(new TextEncoder().encode('pending').buffer);
  await saving;

  expect((await restoring)?.files.map((image) => image.name)).toEqual(['pending.png']);
  expect((await loadNewConversationIntent(BOB))?.files).toEqual([]);
});

it('does not let a pending image save recreate a cleared intent', async () => {
  await saveNewConversationIntent(record(ALICE));
  let releaseBytes: (bytes: ArrayBuffer) => void = () => {};
  const bytes = new Promise<ArrayBuffer>((resolve) => (releaseBytes = resolve));
  const file = new File(['pending'], 'pending.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => bytes });
  const saving = saveNewConversationIntent(record(ALICE, [file]));
  const clearing = clearNewConversationIntent(ALICE);

  await saveNewConversationIntent(record(BOB));
  releaseBytes(new TextEncoder().encode('pending').buffer);
  await Promise.all([saving, clearing]);

  expect(await loadNewConversationIntent(ALICE)).toBeNull();
});

it('continues saving after an earlier image read fails', async () => {
  const file = new File(['unreadable'], 'unreadable.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.reject(new Error('image read failed')) });
  await expect(saveNewConversationIntent(record(ALICE, [file]))).rejects.toThrow('image read failed');

  await saveNewConversationIntent(record(ALICE));
  expect(await loadNewConversationIntent(ALICE)).toMatchObject({ ownerUserId: ALICE, files: [] });
});
