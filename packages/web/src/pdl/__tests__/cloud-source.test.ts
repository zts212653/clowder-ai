import { afterEach, expect, it, vi } from 'vitest';
import { type RecoveryLoadState, readRecoveryState } from '@/components/cloud-binding-recovery-operations';
import { useCloudBindingRecovery } from '@/components/useCloudBindingRecovery';
import { useCloudReply } from '@/components/useCloudReply';
import { apiFetch } from '@/utils/api-client';
import { act, cleanup, renderHook } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/cloud-binding-recovery-operations', async (original) => ({
  ...(await original<typeof import('@/components/cloud-binding-recovery-operations')>()),
  readRecoveryState: vi.fn(),
}));
afterEach(cleanup);
const identity = { threadId: 'thread', sourceMessageId: 'message', targetCatId: 'gpt-pro', attemptId: 'attempt' };
const base = {
  loadState: {
    kind: 'ready' as const,
    boundChatUrl: null,
    provider: 'chatgpt',
    hydratedAttemptId: 'attempt',
    retryState: 'ready' as const,
  },
  phase: 'idle' as const,
  operationError: null,
};

it('shows the held full recovery immediately on remount and retains it through a reconnect read', async () => {
  let finish!: (value: RecoveryLoadState) => void;
  vi.mocked(readRecoveryState).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let generation = 1;
  const seen: string[] = [];
  const hook = renderHook(() => {
    const value = useCloudBindingRecovery(identity, generation, base);
    seen.push(value.loadState.kind);
    return value;
  });
  expect(hook.result.current.loadState).toBe(base.loadState);
  await act(async () => finish({ ...base.loadState, boundChatUrl: 'https://chatgpt.com/c/conversation' }));
  const held = hook.result.current.loadState;
  generation = 2;
  await act(hook.rerender);
  expect(hook.result.current.loadState).toBe(held);
  expect(seen).not.toContain('loading');
  await act(async () => finish({ ...base.loadState, boundChatUrl: 'https://chatgpt.com/c/conversation' }));
  expect(hook.result.current.loadState.kind).toBe('ready');
});

it('keeps the last full state when delivery becomes terminal and stops reading', async () => {
  vi.mocked(readRecoveryState).mockResolvedValue(base.loadState);
  let current = { ...identity, deliveryStatus: 'sending' as 'sending' | 'sent' };
  const hook = renderHook(() => useCloudBindingRecovery(current, 1, base));
  await act(async () => {});
  const count = vi.mocked(readRecoveryState).mock.calls.length;
  current = { ...current, deliveryStatus: 'sent' };
  await act(hook.rerender);
  expect(hook.result.current.loadState.kind).toBe('ready');
  expect(readRecoveryState).toHaveBeenCalledTimes(count);
});

it('keeps the attested reply while its reappearance lookup is pending', async () => {
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
  const held = { state: 'replied' as const, replyMessageId: 'reply' };
  let generation = 1;
  const scope = { sourceMessageId: 'message', targetCatId: 'gpt-pro', dispatchInvocationId: 'attempt' };
  const hook = renderHook(() => useCloudReply(scope, 'thread', [], { readGeneration: generation, initial: held }));
  expect(hook.result.current).toBe(held);
  generation = 2;
  await act(hook.rerender);
  expect(hook.result.current).toBe(held);
});
