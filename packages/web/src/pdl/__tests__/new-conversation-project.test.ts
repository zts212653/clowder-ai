import { afterEach, expect, it, vi } from 'vitest';
import { buildNewConversationCreateBody } from '@/components/new-conversation/new-conversation-create-request';
import { freshIntent, hydrateAdmissionState } from '@/components/new-conversation/new-conversation-hydration';
import { loadNewConversationIntent } from '@/components/new-conversation/new-conversation-intent-store';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/new-conversation/new-conversation-intent-store', () => ({ loadNewConversationIntent: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it('leaves a new conversation unpicked instead of deriving its project from the server cwd', async () => {
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ userId: 'owner' }));
  vi.mocked(loadNewConversationIntent).mockResolvedValue(null);
  const state = await hydrateAdmissionState(new AbortController().signal);
  expect(state.intent.projectPath).toBeUndefined();
  expect(buildNewConversationCreateBody(state.intent)).toEqual({ idempotencyKey: state.intent.createIdempotencyKey });
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual(['/api/session']);
});

it('restores an explicitly picked project from the owner draft', async () => {
  const intent = freshIntent('/projects/chosen');
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ userId: 'owner' }));
  vi.mocked(loadNewConversationIntent).mockResolvedValue({
    ownerUserId: 'owner',
    intent,
    files: [],
    contextAttachments: [],
    updatedAt: 1,
  });
  const state = await hydrateAdmissionState(new AbortController().signal);
  expect(state.intent).toBe(intent);
});
