// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import type { PersistedNewConversationIntent } from '../new-conversation-intent-store';
import {
  _resetNewConversationIntentDbForTests,
  cancelNewConversationIntentSave,
  clearNewConversationIntent,
  getNewConversationIntentSaveState,
  loadNewConversationIntent,
  retryNewConversationIntentSave,
  saveNewConversationIntent,
  subscribeNewConversationIntentSaveState,
} from '../new-conversation-intent-store';

const ALICE = 'save-recovery-alice';
const BOB = 'save-recovery-bob';

function record(ownerUserId: string, files: File[] = [], updatedAt = 1): PersistedNewConversationIntent {
  return {
    ownerUserId,
    intent: {
      v: 1,
      createIdempotencyKey: '11111111-1111-4111-8111-111111111111',
      messageIdempotencyKey: '22222222-2222-4222-8222-222222222222',
      preferredCats: [],
      creationStarted: false,
    },
    files,
    contextAttachments: [],
    updatedAt,
  };
}

function gatedFile(name = 'pending.png') {
  let releaseBytes: (bytes: ArrayBuffer) => void = () => {};
  const bytes = new Promise<ArrayBuffer>((resolve) => {
    releaseBytes = resolve;
  });
  const file = new File(['pending'], name, { type: 'image/png' });
  const read = vi.fn(() => bytes);
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  return {
    file,
    read,
    release: () => releaseBytes(new TextEncoder().encode(name).buffer as ArrayBuffer),
  };
}

afterEach(async () => {
  await clearNewConversationIntent(ALICE).catch(() => undefined);
  await clearNewConversationIntent(BOB).catch(() => undefined);
  _resetNewConversationIntentDbForTests();
});

it('loads the newest pending image without waiting for its read and reports saving', async () => {
  await saveNewConversationIntent(record(ALICE));
  const gate = gatedFile();
  const saving = saveNewConversationIntent(record(ALICE, [gate.file])).catch((error: unknown) => error);
  try {
    expect(getNewConversationIntentSaveState(ALICE)).toBe('saving');
    const restored = await loadNewConversationIntent(ALICE);
    expect(restored?.files.map((file) => file.name)).toEqual(['pending.png']);
    await saveNewConversationIntent(record(BOB));
    expect(getNewConversationIntentSaveState(BOB)).toBe('idle');
  } finally {
    gate.release();
    await saving;
  }
  expect(getNewConversationIntentSaveState(ALICE)).toBe('idle');
  expect((await loadNewConversationIntent(ALICE))?.files).toHaveLength(1);
});

it('clears without releasing the gated read and rejects its late write', async () => {
  await saveNewConversationIntent(record(ALICE));
  const gate = gatedFile();
  const saving = saveNewConversationIntent(record(ALICE, [gate.file])).catch((error: unknown) => error);
  let cleared = false;
  const clearing = clearNewConversationIntent(ALICE).then(() => {
    cleared = true;
  });
  try {
    await saveNewConversationIntent(record(BOB));
    expect(cleared).toBe(true);
    expect(await loadNewConversationIntent(ALICE)).toBeNull();
  } finally {
    gate.release();
    await Promise.all([saving, clearing]);
  }
  expect(await loadNewConversationIntent(ALICE)).toBeNull();
});

it('lets a newer empty save land before the older image read finishes', async () => {
  await saveNewConversationIntent(record(ALICE));
  const gate = gatedFile('removed.png');
  const saving = saveNewConversationIntent(record(ALICE, [gate.file])).catch((error: unknown) => error);
  let removed = false;
  const removing = saveNewConversationIntent(record(ALICE, [], 2)).then(() => {
    removed = true;
  });
  try {
    await saveNewConversationIntent(record(BOB));
    expect(removed).toBe(true);
    expect(await loadNewConversationIntent(ALICE)).toEqual(expect.objectContaining({ files: [] }));
  } finally {
    gate.release();
    await Promise.all([saving, removing]);
  }
  expect((await loadNewConversationIntent(ALICE))?.files).toEqual([]);
  expect(await saving).toMatchObject({ name: 'AbortError' });
});

it('retains a failed snapshot, dedupes identical automatic saves, and retries only on demand', async () => {
  const read = vi.fn(() => Promise.reject(new Error('image read failed')));
  const file = new File(['unreadable'], 'unreadable.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  await expect(saveNewConversationIntent(record(ALICE, [file]))).rejects.toThrow('image read failed');
  expect(getNewConversationIntentSaveState(ALICE)).toBe('failed');
  expect((await loadNewConversationIntent(ALICE))?.files.map((entry) => entry.name)).toEqual(['unreadable.png']);

  const automatic = saveNewConversationIntent(record(ALICE, [file], 99)).catch((error: unknown) => error);
  expect(await automatic).toMatchObject({ message: 'image read failed' });
  expect(read).toHaveBeenCalledTimes(1);

  const retried = retryNewConversationIntentSave(ALICE).catch((error: unknown) => error);
  expect(await retried).toMatchObject({ message: 'image read failed' });
  expect(read).toHaveBeenCalledTimes(2);

  await saveNewConversationIntent(record(ALICE, [], 100));
  expect(getNewConversationIntentSaveState(ALICE)).toBe('idle');
  expect((await loadNewConversationIntent(ALICE))?.files).toEqual([]);
});

it('reuses an in-flight attempt for an identical snapshot instead of reading again', async () => {
  const gate = gatedFile();
  const first = saveNewConversationIntent(record(ALICE, [gate.file])).catch((error: unknown) => error);
  const second = saveNewConversationIntent(record(ALICE, [gate.file], 55)).catch((error: unknown) => error);
  expect(gate.read).toHaveBeenCalledTimes(1);
  expect(getNewConversationIntentSaveState(ALICE)).toBe('saving');
  gate.release();
  await Promise.all([first, second]);
  expect(getNewConversationIntentSaveState(ALICE)).toBe('idle');
  expect((await loadNewConversationIntent(ALICE))?.files).toHaveLength(1);
});

it('notifies saving and cancelled and stops notifications after unsubscribe', async () => {
  const events: string[] = [];
  const unsubscribe = subscribeNewConversationIntentSaveState(ALICE, () => {
    events.push(getNewConversationIntentSaveState(ALICE));
  });
  const gate = gatedFile();
  const saving = saveNewConversationIntent(record(ALICE, [gate.file])).catch((error: unknown) => error);
  expect(events).toContain('saving');
  cancelNewConversationIntentSave(ALICE);
  expect(getNewConversationIntentSaveState(ALICE)).toBe('cancelled');
  expect(events).toContain('cancelled');
  expect(await saving).toMatchObject({ name: 'AbortError' });
  unsubscribe();
  gate.release();
  await saveNewConversationIntent(record(ALICE));
  expect(events.filter((event) => event === 'saving')).toHaveLength(1);
});

it('treats an explicitly empty pending as the current draft over an older stored image', async () => {
  const image = new File(['old'], 'old.png', { type: 'image/png' });
  await saveNewConversationIntent(record(ALICE, [image]));
  const saving = saveNewConversationIntent(record(ALICE, [], 2));
  expect((await loadNewConversationIntent(ALICE))?.files).toEqual([]);
  await saving;
  expect((await loadNewConversationIntent(ALICE))?.files).toEqual([]);
});

it('keeps owners independent and treats missing owners as idle', async () => {
  expect(getNewConversationIntentSaveState(null)).toBe('idle');
  expect(getNewConversationIntentSaveState('missing-owner')).toBe('idle');
  await retryNewConversationIntentSave('missing-owner');
  cancelNewConversationIntentSave('missing-owner');

  const gate = gatedFile();
  const saving = saveNewConversationIntent(record(ALICE, [gate.file])).catch((error: unknown) => error);
  await saveNewConversationIntent(record(BOB));
  expect(getNewConversationIntentSaveState(ALICE)).toBe('saving');
  expect(getNewConversationIntentSaveState(BOB)).toBe('idle');
  gate.release();
  await saving;
});

it('does not return a clearing snapshot to a load issued right after clear', async () => {
  await saveNewConversationIntent(record(ALICE));
  const gate = gatedFile('cleared.png');
  const saving = saveNewConversationIntent(record(ALICE, [gate.file])).catch((error: unknown) => error);
  const clearing = clearNewConversationIntent(ALICE);
  const restoring = loadNewConversationIntent(ALICE);
  try {
    await expect(restoring).resolves.toBeNull();
  } finally {
    gate.release();
    await Promise.all([saving, clearing]);
  }
  expect(await loadNewConversationIntent(ALICE)).toBeNull();
});

it('lets a save issued after clear become the new pending and survive the delete', async () => {
  await saveNewConversationIntent(record(ALICE));
  const oldGate = gatedFile('old.png');
  const saving = saveNewConversationIntent(record(ALICE, [oldGate.file])).catch((error: unknown) => error);
  const clearing = clearNewConversationIntent(ALICE);
  const newGate = gatedFile('new.png');
  const replacement = saveNewConversationIntent(record(ALICE, [newGate.file], 3)).catch(
    (error: unknown) => error,
  );
  try {
    expect((await loadNewConversationIntent(ALICE))?.files.map((file) => file.name)).toEqual(['new.png']);
    await clearing;
  } finally {
    oldGate.release();
    newGate.release();
    await Promise.all([saving, replacement]);
  }
  expect((await loadNewConversationIntent(ALICE))?.files.map((file) => file.name)).toEqual(['new.png']);
});
