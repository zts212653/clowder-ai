import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import type { SendAttempt } from '@/utils/send-attempt-db';
import {
  checkSendAttempt,
  findSendAttempt,
  patchSendAttempt,
  putSendAttempt,
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
  observeApiSessionOwner(attempt.ownerUserId);
  useSendAttemptStore.setState({ attempts: [] });
  apiFetch.mockReset();
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
it('does not read another account receipt after the browser owner changes', async () => {
  putSendAttempt(attempt);
  observeApiSessionOwner('other-owner');
  await checkSendAttempt(attempt);
  expect(apiFetch).not.toHaveBeenCalled();
});
