// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import type { PersistedNewConversationIntent } from '../new-conversation-intent-store';
import {
  _resetNewConversationIntentDbForTests,
  canCancelNewConversationIntentSave,
  cancelNewConversationIntentSave,
  clearNewConversationIntent,
  getNewConversationIntentSaveState,
  loadNewConversationIntent,
  saveNewConversationIntent,
  subscribeNewConversationIntentSaveState,
} from '../new-conversation-intent-store';

const ALICE = 'cancel-phases-alice';

const boundary = vi.hoisted(() => ({
  beforePut: null as (() => Promise<void>) | null,
  writes: 0,
}));

const activeGates: Array<() => void> = [];

// Keep real IndexedDB and hold only the storage module's put boundary.
vi.mock('idb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('idb')>();
  return {
    ...actual,
    openDB: async (...args: Parameters<typeof actual.openDB>) => {
      const database = await actual.openDB(...args);
      return new Proxy(database, {
        get(target, property) {
          if (property === 'put') {
            return async (...values: Parameters<typeof database.put>) => {
              boundary.writes += 1;
              await boundary.beforePut?.();
              return database.put(...values);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

function record(title: string, updatedAt = 1): PersistedNewConversationIntent {
  return {
    ownerUserId: ALICE,
    intent: {
      v: 1,
      createIdempotencyKey: '11111111-1111-4111-8111-111111111111',
      messageIdempotencyKey: '22222222-2222-4222-8222-222222222222',
      preferredCats: [],
      creationStarted: false,
      title,
    },
    files: [],
    contextAttachments: [],
    updatedAt,
  };
}

function gatePut(): { release: () => void } {
  const gate = Promise.withResolvers<void>();
  activeGates.push(gate.resolve);
  boundary.beforePut = () => gate.promise;
  return { release: gate.resolve };
}

function releaseGates(): void {
  boundary.beforePut = null;
  for (const resolve of activeGates.splice(0)) resolve();
}

afterEach(async () => {
  releaseGates();
  await clearNewConversationIntent(ALICE).catch(() => undefined);
  _resetNewConversationIntentDbForTests();
  boundary.writes = 0;
});

it('only reports cancelable before the atomic write starts', () => {
  expect(canCancelNewConversationIntentSave(null)).toBe(false);
  expect(canCancelNewConversationIntentSave(ALICE)).toBe(false);
});

it('settles a queued cancel before the preceding write is released and skips its write', async () => {
  const gate = gatePut();
  boundary.writes = 0;
  const background = saveNewConversationIntent(record('older', 1)).catch((error: unknown) => error);
  await vi.waitFor(() => expect(boundary.writes).toBe(1));
  const queued = saveNewConversationIntent(record('newer', 2)).catch((error: unknown) => error);
  await vi.waitFor(() => expect(canCancelNewConversationIntentSave(ALICE)).toBe(true));
  cancelNewConversationIntentSave(ALICE);
  expect(getNewConversationIntentSaveState(ALICE)).toBe('cancelled');
  expect(canCancelNewConversationIntentSave(ALICE)).toBe(false);
  expect(await queued).toMatchObject({ name: 'AbortError' });
  expect(boundary.writes).toBe(1);
  gate.release();
  await background;
  expect(boundary.writes).toBe(1);
  expect((await loadNewConversationIntent(ALICE))?.intent.title).toBe('newer');
});

it('does not cancel a writing save and preserves write order', async () => {
  const gate = gatePut();
  boundary.writes = 0;
  const first = saveNewConversationIntent(record('first', 1)).catch((error: unknown) => error);
  await vi.waitFor(() => expect(boundary.writes).toBe(1));
  expect(canCancelNewConversationIntentSave(ALICE)).toBe(false);
  cancelNewConversationIntentSave(ALICE);
  expect(canCancelNewConversationIntentSave(ALICE)).toBe(false);
  let firstSettled = false;
  void first.then(() => {
    firstSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(firstSettled).toBe(false);
  const second = saveNewConversationIntent(record('second', 2)).catch((error: unknown) => error);
  await vi.waitFor(() => expect(canCancelNewConversationIntentSave(ALICE)).toBe(true));
  gate.release();
  await Promise.all([first, second]);
  expect(boundary.writes).toBe(2);
  expect(getNewConversationIntentSaveState(ALICE)).toBe('idle');
  expect((await loadNewConversationIntent(ALICE))?.intent.title).toBe('second');
});

it('notifies when a save enters writing so cancelability can update', async () => {
  const gate = gatePut();
  boundary.writes = 0;
  const seen: boolean[] = [];
  const unsubscribe = subscribeNewConversationIntentSaveState(ALICE, () => {
    seen.push(canCancelNewConversationIntentSave(ALICE));
  });
  const saving = saveNewConversationIntent(record('notify', 1)).catch((error: unknown) => error);
  await vi.waitFor(() => expect(boundary.writes).toBe(1));
  expect(seen).toContain(false);
  expect(canCancelNewConversationIntentSave(ALICE)).toBe(false);
  gate.release();
  await saving;
  expect(getNewConversationIntentSaveState(ALICE)).toBe('idle');
  unsubscribe();
});
