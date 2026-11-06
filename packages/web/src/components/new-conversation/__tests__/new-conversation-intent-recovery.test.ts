// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import {
  _resetNewConversationIntentDbForTests,
  clearNewConversationIntent,
  loadNewConversationIntent,
  saveNewConversationIntent,
} from '../new-conversation-intent-store';

const ALICE = 'recovery-alice';
const BOB = 'recovery-bob';

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

it('restores the latest image without releasing its pending read and lets another owner save', async () => {
  await saveNewConversationIntent(record(ALICE));
  let releaseBytes: (bytes: ArrayBuffer) => void = () => {};
  const bytes = new Promise<ArrayBuffer>((resolve) => (releaseBytes = resolve));
  const file = new File(['pending'], 'pending.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => bytes });
  const saving = saveNewConversationIntent(record(ALICE, [file])).catch((error: unknown) => error);
  let restored: Awaited<ReturnType<typeof loadNewConversationIntent>> | undefined;
  const restoring = loadNewConversationIntent(ALICE).then((value) => (restored = value));
  try {
    // A completed B transaction gives an unblocked local restore a deterministic turn.
    await saveNewConversationIntent(record(BOB));
    expect(restored?.files.map((image) => image.name)).toEqual(['pending.png']);
    expect((await loadNewConversationIntent(BOB))?.files).toEqual([]);
  } finally {
    releaseBytes(new TextEncoder().encode('pending').buffer);
    await Promise.all([saving, restoring]);
  }
});

it('clears without releasing an old read and rejects its late write', async () => {
  await saveNewConversationIntent(record(ALICE));
  let releaseBytes: (bytes: ArrayBuffer) => void = () => {};
  const bytes = new Promise<ArrayBuffer>((resolve) => (releaseBytes = resolve));
  const file = new File(['pending'], 'pending.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => bytes });
  const saving = saveNewConversationIntent(record(ALICE, [file])).catch((error: unknown) => error);
  let cleared = false;
  const clearing = clearNewConversationIntent(ALICE).then(() => (cleared = true));
  try {
    await saveNewConversationIntent(record(BOB));
    expect(cleared).toBe(true);
  } finally {
    releaseBytes(new TextEncoder().encode('pending').buffer);
    await Promise.all([saving, clearing]);
  }
  expect(await loadNewConversationIntent(ALICE)).toBeNull();
});

it('persists an explicit removal before an older image read finishes', async () => {
  await saveNewConversationIntent(record(ALICE));
  let releaseBytes: (bytes: ArrayBuffer) => void = () => {};
  const bytes = new Promise<ArrayBuffer>((resolve) => (releaseBytes = resolve));
  const file = new File(['pending'], 'removed.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => bytes });
  const saving = saveNewConversationIntent(record(ALICE, [file])).catch((error: unknown) => error);
  let removed = false;
  const removing = saveNewConversationIntent(record(ALICE)).then(() => (removed = true));
  try {
    await saveNewConversationIntent(record(BOB));
    expect(removed).toBe(true);
  } finally {
    releaseBytes(new TextEncoder().encode('pending').buffer);
    await Promise.all([saving, removing]);
  }
  expect((await loadNewConversationIntent(ALICE))?.files).toEqual([]);
});

it('retains a failed image for recovery and accepts a newer save', async () => {
  await saveNewConversationIntent(record(ALICE));
  const file = new File(['unreadable'], 'unreadable.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.reject(new Error('image read failed')) });
  await expect(saveNewConversationIntent(record(ALICE, [file]))).rejects.toThrow('image read failed');
  expect((await loadNewConversationIntent(ALICE))?.files.map((image) => image.name)).toEqual(['unreadable.png']);

  await saveNewConversationIntent(record(ALICE));
  expect((await loadNewConversationIntent(ALICE))?.files).toEqual([]);
});
