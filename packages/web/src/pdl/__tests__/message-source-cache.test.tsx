import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import type { ChatData } from '../chat-models';
import { useMessageSourceBindings } from '../useMessageSourceBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
afterEach(cleanup);

function generationMessage(id: string, revision = 1, status: 'processing' | 'completed' = 'completed') {
  return {
    ...fixtureData().messages[0]!,
    id,
    extra: undefined,
    source: undefined,
    lifecycle: {
      kind: 'response',
      orderKey: id,
      invocationId: id,
      targetId: 'codex',
      inputEntryIds: [],
      inputMessageIds: [],
      startedAt: 1,
      latestInputTimelineOrderAt: revision,
      status,
      ...(status === 'completed' ? { completedAt: 5 } : {}),
    },
  } satisfies ChatData['messages'][number];
}

function dataWith(messages: ChatData['messages']) {
  return { ...fixtureData(), messages };
}

const generationCalls = () =>
  vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).includes('/generation-messages'));

it('reuses a completed generation instead of re-reading it on every lifecycle update', async () => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (String(path).includes('/generation-messages'))
      return Response.json({ messageIds: [], hasAppendedInputs: false, complete: true });
    throw new Error('Unexpected source read: ' + path);
  });
  let data = dataWith([generationMessage('g1'), generationMessage('g2')]);
  const hook = renderHook(() => useMessageSourceBindings(data, 1));
  await waitFor(() => expect(generationCalls()).toHaveLength(2));

  data = dataWith([generationMessage('g1'), generationMessage('g2'), { ...fixtureData().messages[0]!, id: 'next' }]);
  await act(hook.rerender);
  await waitFor(() => expect(generationCalls()).toHaveLength(2));
});

it('keeps a failed generation retryable when its lifecycle moves again', async () => {
  vi.mocked(apiFetch).mockReset();
  let fail = true;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (!String(path).includes('/generation-messages')) throw new Error('Unexpected source read: ' + path);
    return fail
      ? Response.json({ error: 'generation temporarily unavailable' }, { status: 500 })
      : Response.json({ messageIds: [], hasAppendedInputs: false, complete: true });
  });
  let data = dataWith([generationMessage('retry-g')]);
  const hook = renderHook(() => useMessageSourceBindings(data, 1));
  await waitFor(() => expect(generationCalls()).toHaveLength(1));

  fail = false;
  data = dataWith([generationMessage('retry-g', 2)]);
  await act(hook.rerender);
  await waitFor(() => expect(generationCalls()).toHaveLength(2));
});

it('publishes the same pending generation after an unrelated message changes the effect', async () => {
  vi.mocked(apiFetch).mockReset();
  const pending = Promise.withResolvers<Response>();
  vi.mocked(apiFetch).mockImplementation(() => pending.promise);
  const original = generationMessage('in-flight');
  let data = dataWith([original]);
  const hook = renderHook(() => useMessageSourceBindings(data, true));
  await waitFor(() => expect(generationCalls()).toHaveLength(1));

  data = dataWith([original, { ...fixtureData().messages[0]!, id: 'next' }]);
  await act(hook.rerender);
  await act(() => {
    pending.resolve(Response.json({ messageIds: ['first'], hasAppendedInputs: false, complete: true }));
  });

  expect(generationCalls()).toHaveLength(1);
  expect(hook.result.current.data.records.generations['in-flight']?.messageIds).toEqual(['first']);
});

it('refreshes a processing generation even if the previous scan reached the end', async () => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({ messageIds: ['first'], hasAppendedInputs: true, complete: true }),
  );
  let data = dataWith([generationMessage('live', 1, 'processing'), generationMessage('past')]);
  const hook = renderHook(() => useMessageSourceBindings(data, true));
  await waitFor(() => expect(hook.result.current.data.records.generations.live?.complete).toBe(true));
  data = dataWith([generationMessage('live', 2, 'processing'), generationMessage('past')]);
  await act(hook.rerender);
  expect(generationCalls()).toHaveLength(3);
  expect(generationCalls().filter(([path]) => String(path).includes('/live/'))).toHaveLength(2);
});

it('re-reads completed generations after input deletion and reconnect', async () => {
  vi.mocked(apiFetch).mockReset();
  let ids = ['deleted', 'kept'];
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({ messageIds: ids, hasAppendedInputs: false, complete: true }),
  );
  const generation = generationMessage('past');
  const previousInput = { ...fixtureData().messages[0]!, id: 'deleted', extra: undefined, source: undefined };
  let data = dataWith([previousInput, generation]);
  let needed = 1;
  const hook = renderHook(() => useMessageSourceBindings(data, needed));
  await waitFor(() => expect(hook.result.current.data.records.generations.past?.messageIds).toEqual(ids));

  ids = ['kept'];
  data = dataWith([generation]);
  await act(hook.rerender);
  await waitFor(() => expect(hook.result.current.data.records.generations.past?.messageIds).toEqual(ids));

  ids = ['changed while disconnected'];
  needed = 2;
  await act(hook.rerender);
  await waitFor(() => expect(hook.result.current.data.records.generations.past?.messageIds).toEqual(ids));
  expect(generationCalls()).toHaveLength(3);
});

it('publishes no old source records while the new account is still loading', async () => {
  vi.mocked(apiFetch).mockReset();
  const pending = Promise.withResolvers<Response>();
  const data = dataWith([generationMessage('shared-id')]);
  observeApiSessionOwner('source-owner-a');
  vi.mocked(apiFetch)
    .mockResolvedValueOnce(Response.json({ messageIds: ['private-a'], hasAppendedInputs: false, complete: true }))
    .mockReturnValueOnce(pending.promise);
  const hook = renderHook(() => useMessageSourceBindings(data, 1));
  await waitFor(() =>
    expect(hook.result.current.data.records.generations['shared-id']?.messageIds).toEqual(['private-a']),
  );

  await act(() => observeApiSessionOwner('source-owner-b'));
  expect(hook.result.current.data.records.generations).toEqual({});
  await act(() => {
    pending.resolve(Response.json({ messageIds: ['private-b'], hasAppendedInputs: false, complete: true }));
  });
  expect(hook.result.current.data.records.generations['shared-id']?.messageIds).toEqual(['private-b']);
});
