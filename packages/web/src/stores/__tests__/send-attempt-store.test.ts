import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import type { SendAttempt } from '@/utils/send-attempt-db';
import * as attemptDb from '@/utils/send-attempt-db';
import { useChatStore } from '../chatStore';
import {
  checkSendAttempt,
  findSendAttempt,
  observeCanceledSendAttempts,
  observeQueuedSendAttempts,
  patchSendAttempt,
  putSendAttempt,
  retireSendAttempt,
  useSendAttemptStore,
} from '../send-attempt-store';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
const attempt: SendAttempt = {
  id: 'store-key',
  ownerUserId: 'store-owner',
  threadId: 'store-thread',
  content: 'keep',
  files: [],
  timestamp: 10,
  status: 'unknown',
};
beforeEach(() => {
  vi.restoreAllMocks();
  observeApiSessionOwner(attempt.ownerUserId);
  useSendAttemptStore.setState({ attempts: [] });
  apiFetch.mockReset();
});

it('commits a refusal before displaying failed so an immediate reload keeps its recovery action', async () => {
  const sending = { ...attempt, status: 'sending' as const };
  await attemptDb.saveSendAttempt(sending);
  putSendAttempt(sending);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = attemptDb.updateStoredSendAttempt;
  vi.spyOn(attemptDb, 'updateStoredSendAttempt').mockImplementationOnce(async (next) => {
    await gate;
    await write(next);
  });
  const committed = patchSendAttempt(sending, { status: 'failed', error: 'queue full' });
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)?.status).toBe('sending');
  release();
  await committed;
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)?.status).toBe('failed');
  expect((await attemptDb.loadSendAttempts(attempt.ownerUserId, attempt.threadId))[0]?.status).toBe('failed');
  await attemptDb.deleteSendAttempt(sending);
});
it('does not resend or interpret an absent receipt as rejection; read failures remain unknown', async () => {
  putSendAttempt(attempt);
  apiFetch.mockResolvedValue(new Response('{"status":"unknown"}'));
  await checkSendAttempt(attempt);
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)?.status).toBe('unknown');
  expect(apiFetch.mock.calls.every((call) => call[1]?.method !== 'POST')).toBe(true);
  apiFetch.mockResolvedValue(new Response('{}', { status: 503 }));
  await checkSendAttempt(attempt);
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)).toMatchObject({
    status: 'unknown',
    error: '未能核对，请稍后重试',
  });
});
it('cannot downgrade or rename a delivered attempt when HTTP acknowledgement arrives late', () => {
  putSendAttempt({ ...attempt, status: 'delivered', serverMessageId: 'canonical-id' });
  patchSendAttempt(attempt, { status: 'accepted', serverMessageId: 'wrong-id' });
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)).toMatchObject({
    status: 'delivered',
    serverMessageId: 'canonical-id',
  });
});
it('accepts real delivery proof after a cancellation without accepting a late admission', async () => {
  putSendAttempt({ ...attempt, status: 'canceled', serverMessageId: 'canonical-id' });
  await patchSendAttempt(attempt, { status: 'accepted' });
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)?.status).toBe('canceled');
  await patchSendAttempt(attempt, { status: 'delivered' });
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)?.status).toBe('delivered');
});
it('does not read another account receipt after the browser owner changes', async () => {
  putSendAttempt(attempt);
  observeApiSessionOwner('other-owner');
  await checkSendAttempt(attempt);
  expect(apiFetch).not.toHaveBeenCalled();
});

it('releases an abandoned checking state without consuming a different account receipt', async () => {
  putSendAttempt(attempt);
  let resolve!: (value: Response) => void;
  apiFetch.mockImplementationOnce(
    () =>
      new Promise<Response>((finish) => {
        resolve = finish;
      }),
  );
  const checking = checkSendAttempt(attempt);
  observeApiSessionOwner('other-owner');
  resolve(new Response(JSON.stringify({ status: 'accepted', userMessage: { id: 'not-consumed', timestamp: 10 } })));
  await checking;
  observeApiSessionOwner(attempt.ownerUserId);
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)).toMatchObject({ status: 'unknown' });
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)?.serverMessageId).toBeUndefined();
});

it('keeps a canceled Queue input and its body across reload and late acknowledgement', async () => {
  const accepted = { ...attempt, status: 'accepted' as const, serverMessageId: 'canceled-id' };
  await attemptDb.saveSendAttempt(accepted);
  putSendAttempt(accepted);
  apiFetch.mockResolvedValue(
    new Response(JSON.stringify({ status: 'canceled', userMessage: { id: 'canceled-id', timestamp: 10 } })),
  );
  observeQueuedSendAttempts(attempt.threadId, []);
  await vi.waitFor(() =>
    expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)?.status).toBe('canceled'),
  );
  expect((await attemptDb.loadSendAttempts(attempt.ownerUserId, attempt.threadId))[0]).toMatchObject({
    status: 'canceled',
    content: 'keep',
  });
  await patchSendAttempt(accepted, { status: 'accepted' });
  apiFetch.mockResolvedValue(new Response('{}', { status: 503 }));
  await observeCanceledSendAttempts(attempt.threadId, ['canceled-id']);
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)?.status).toBe('canceled');
  expect(apiFetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  await attemptDb.deleteSendAttempt(accepted);
});

it.each([
  'deleted',
  'recalled',
] as const)('removes a %s input only on explicit evidence and protects the stale draft', async (removal) => {
  const saved = { ...attempt, status: 'canceled' as const, serverMessageId: 'removed-id', composerDraftRevision: 1 };
  await attemptDb.saveSendAttempt(saved);
  putSendAttempt(saved);
  apiFetch.mockResolvedValue(new Response(JSON.stringify({ draft: { text: 'keep', revision: 1 }, revision: 1 })));
  await observeCanceledSendAttempts(attempt.threadId, ['removed-id'], removal);
  if (removal === 'deleted') {
    expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)).toMatchObject({ removed: true });
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ draft: null, revision: 2 })));
    await retireSendAttempt(saved);
  }
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)).toBeUndefined();
  expect(await attemptDb.loadSendAttempts(attempt.ownerUserId, attempt.threadId)).toEqual([]);
});

it.each([
  'accepted',
  'delivered',
] as const)('requires a removal receipt after soft deletion of an %s input', async (status) => {
  const saved = { ...attempt, status, serverMessageId: 'soft-id' };
  await attemptDb.saveSendAttempt(saved);
  putSendAttempt(saved);
  apiFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'unknown' })));
  await observeCanceledSendAttempts(attempt.threadId, ['soft-id']);
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)).toMatchObject({ status });
  apiFetch.mockResolvedValue(
    new Response(JSON.stringify({ status: 'removed', userMessage: { id: 'soft-id', timestamp: 10 } })),
  );
  await observeCanceledSendAttempts(attempt.threadId, ['soft-id']);
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)).toBeUndefined();
});

it('asks the existing History owner to catch up when a read-only receipt proves delivery', async () => {
  putSendAttempt(attempt);
  const before = useChatStore.getState().streamCatchUpVersionByThread[attempt.threadId] ?? 0;
  apiFetch.mockResolvedValue(
    new Response(JSON.stringify({ status: 'delivered', userMessage: { id: 'delivered-id', timestamp: 10 } })),
  );
  await checkSendAttempt(attempt);
  expect(useChatStore.getState().streamCatchUpVersionByThread[attempt.threadId]).toBe(before + 1);
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)?.status).toBe('delivered');
});

it('rechecks a Queue removal that arrives during an older receipt request', async () => {
  const accepted = { ...attempt, status: 'accepted' as const, serverMessageId: 'cancel-during-read' };
  await attemptDb.saveSendAttempt(accepted);
  putSendAttempt(accepted);
  let resolve!: (value: Response) => void;
  apiFetch
    .mockImplementationOnce(
      () =>
        new Promise<Response>((finish) => {
          resolve = finish;
        }),
    )
    .mockResolvedValue(
      new Response(JSON.stringify({ status: 'canceled', userMessage: { id: 'cancel-during-read', timestamp: 10 } })),
    );
  const checking = checkSendAttempt(accepted);
  observeQueuedSendAttempts(attempt.threadId, []);
  resolve(
    new Response(JSON.stringify({ status: 'accepted', userMessage: { id: 'cancel-during-read', timestamp: 10 } })),
  );
  await checking;
  await vi.waitFor(() =>
    expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)?.status).toBe('canceled'),
  );
  expect(apiFetch).toHaveBeenCalledTimes(2);
  await attemptDb.deleteSendAttempt(accepted);
});

it.each([
  { revision: 1, text: 'keep', status: 200, retained: true },
  { revision: 1, text: 'different content', status: 200, retained: true },
  { revision: 2, text: 'new draft', status: 200, retained: false },
  { revision: 2, text: null, status: 200, retained: false },
  { revision: 1, text: null, status: 503, retained: true },
])('keeps the recovery record until the remote draft is cleared: $revision/$text/$status', async ({
  revision,
  text,
  status,
  retained,
}) => {
  const delivered = {
    ...attempt,
    status: 'delivered' as const,
    composerDraftRevision: 1,
    serverMessageId: 'canonical-id',
  };
  await attemptDb.saveSendAttempt(delivered);
  putSendAttempt(delivered);
  apiFetch.mockResolvedValue(
    new Response(JSON.stringify({ draft: text === null ? null : { text, revision }, revision }), { status }),
  );
  await retireSendAttempt(delivered).catch(() => {});
  expect(Boolean(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id))).toBe(retained);
  expect((await attemptDb.loadSendAttempts(attempt.ownerUserId, attempt.threadId)).length).toBe(retained ? 1 : 0);
  if (retained) {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ draft: null, revision: 2 })));
    await retireSendAttempt(delivered);
  }
});

it('abandons retirement if the account changes while the owner draft read is in flight', async () => {
  const delivered = { ...attempt, status: 'delivered' as const, composerDraftRevision: 1 };
  await attemptDb.saveSendAttempt(delivered);
  putSendAttempt(delivered);
  let resolve!: (response: Response) => void;
  apiFetch.mockImplementationOnce(
    () =>
      new Promise<Response>((finish) => {
        resolve = finish;
      }),
  );
  const retiring = retireSendAttempt(delivered);
  observeApiSessionOwner('other-owner');
  resolve(new Response(JSON.stringify({ draft: null, revision: 2 })));
  await retiring;
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)).toBeDefined();
  await attemptDb.deleteSendAttempt(delivered);
});

it('shares one draft verification between concurrent retirement requests', async () => {
  const saved = { ...attempt, status: 'delivered' as const, composerDraftRevision: 1 };
  await attemptDb.saveSendAttempt(saved);
  putSendAttempt(saved);
  let resolve!: (value: Response) => void;
  apiFetch.mockImplementationOnce(
    () =>
      new Promise<Response>((finish) => {
        resolve = finish;
      }),
  );
  const first = retireSendAttempt(saved);
  const second = retireSendAttempt(saved);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  resolve(new Response(JSON.stringify({ draft: null, revision: 2 })));
  await Promise.all([first, second]);
  expect(findSendAttempt(attempt.ownerUserId, attempt.threadId, attempt.id)).toBeUndefined();
});

it('preserves whisper presentation when the canonical delivery replaces a local attempt', () => {
  useChatStore.setState({ currentThreadId: attempt.threadId, messages: [] });
  useChatStore.getState().markMessagesDelivered(attempt.threadId, ['whisper-id'], 20, [
    {
      id: 'whisper-id',
      clientMessageId: attempt.id,
      from: { kind: 'user', userId: attempt.ownerUserId },
      content: attempt.content,
      timestamp: 10,
      catId: null,
      visibility: 'whisper',
      whisperTo: ['opus'],
    },
  ]);
  expect(useChatStore.getState().messages[0]).toMatchObject({ visibility: 'whisper', whisperTo: ['opus'] });
});
