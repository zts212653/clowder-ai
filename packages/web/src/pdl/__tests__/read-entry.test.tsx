import { readFileSync } from 'node:fs';
import { useEffect } from 'react';
import { ScriptTarget, transpileModule } from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApprovalStatus } from '@/components/rich/use-approval-status';
import { readApprovalProducerBody } from '@/lib/approval-producer-read';
import { approvalResultRead } from '@/lib/approval-result-read';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import { apiFetch } from '@/utils/api-client';
import { observeApiSessionOwner } from '@/utils/api-session-identity';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { request } from '../owner-api';
import { ProposalRecordBinding } from '../PdlAppHost';
import {
  type ProposalBinding,
  type ProposalTarget,
  proposalView,
  readProposal,
  recheckProposal,
} from '../proposal-models';
import { useMessageSourceBindings } from '../useMessageSourceBindings';
import { useRecallBindings } from '../useRecallBindings';
import { useSidebarBindings } from '../useSidebarBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  approvalResultRead.clear();
  observeApiSessionOwner('owner');
});
afterEach(cleanup);

it('keeps the shared native body intact and projects the proposal binding from that body', async () => {
  const target: ProposalTarget = {
    feature: 'F128',
    id: 'proposal',
    threadId: 'thread',
    mid: 'message',
    blockId: 'card',
  };
  const proposal = {
    proposalId: target.id,
    status: 'pending',
    sourceThreadId: target.threadId,
    sourceCatId: 'codex',
    cardMessageId: target.mid,
    title: 'A separate task',
    reason: 'Separate work',
    parentThreadId: target.threadId,
    preferredCats: ['codex'],
    projectPath: '/project',
    createdBy: 'owner',
    createdAt: 1,
  };
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ proposal }));
  let binding!: ProposalBinding;
  const changed = (value: ProposalBinding) => {
    binding = value;
  };
  renderHook(
    () => null,
    () => <ProposalRecordBinding target={target} generation={1} changed={changed} />,
  );
  await waitFor(() => expect(binding.current).toBe(true));
  const key = { owner: 'owner', producer: target.feature, proposalId: target.id };
  const held = approvalResultRead.snapshot<{ proposal: typeof proposal }>(key, 'native').value!;
  expect(held).toEqual({ proposal });
  expect(binding.record).toBe(held.proposal);
  expect(proposalView(binding, false, false, {})?.fields).toContainEqual({ field: 'members', v: ['codex'] });
  expect(await readApprovalProducerBody(key, '/api/proposals/proposal')).toBe(held);
  expect(await readProposal(target)).toBe(binding.record);
  const status = renderHook(() => useApprovalStatus('F128', target.id, '/api/proposals/proposal'));
  await waitFor(() => expect(status.result.current.status).toBe('pending'));
  expect(status.result.current.record).toBe(binding.record);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await act(() => approvalResultRead.seedFacts(key, { native: { proposal: { ...proposal, title: 'Updated task' } } }));
  expect(binding.record?.proposalId).toBe(target.id);
  expect(proposalView(binding, false, false, {})?.title).toBe('Updated task');
  expect(status.result.current.record).toBe(binding.record);
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it('pulls recall once on entry and uses message increments without re-reading when history or a final reply arrives', async () => {
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({
      days: 0,
      from: 0,
      to: 20,
      readStatus: 'ready',
      records: [
        {
          threadId: 'pdl-test',
          threadTitle: 'A conversation',
          event: { id: 'history', query: 'Stored search', timestamp: 1 },
        },
      ],
      replies: [],
      nextCursor: null,
    }),
  );
  let data = { ...fixtureData(), messages: [] as ReturnType<typeof fixtureData>['messages'] },
    needed: number | false = false;
  const ui = { recallFor: null, recallExpected: 0 };
  const hook = renderHook(() => useRecallBindings(data, ui, needed));
  expect(apiFetch).not.toHaveBeenCalled();
  needed = 1;
  await act(hook.rerender);
  await waitFor(() => expect(hook.result.current.data.load).toBe(''));
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/memory/recall?days=0&threadId=pdl-test&limit=100',
    expect.anything(),
    undefined,
  );
  data = { ...data, messages: fixtureData().messages };
  await act(hook.rerender);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  const streaming = {
    ...data.messages[1],
    id: 'streaming',
    isStreaming: true,
    toolEvents: [
      {
        id: 'live-search',
        type: 'tool_use' as const,
        label: 'search_evidence',
        detail: '{"query":"Live search"}',
        toolUseId: 'tool',
        timestamp: 10,
      },
    ],
  };
  data = { ...data, messages: [...data.messages, streaming] };
  await act(hook.rerender);
  expect(hook.result.current.data.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'history', query: 'Stored search' }),
      expect.objectContaining({ id: 'live-search', query: 'Live search', messageId: 'streaming' }),
    ]),
  );
  data = {
    ...data,
    messages: [
      ...data.messages.slice(0, -1),
      {
        ...streaming,
        isStreaming: false,
        toolEvents: [
          ...streaming.toolEvents,
          {
            id: 'live-result',
            type: 'tool_result',
            label: 'search_evidence',
            toolUseId: 'tool',
            timestamp: 11,
            detail: 'Evidence search results:\nFound 2 result(s) for "Live search":',
          },
        ],
      },
    ],
  };
  await act(hook.rerender);
  expect(hook.result.current.data.events.find((event) => event.id === 'live-search')).toMatchObject({ resultCount: 2 });
  expect(apiFetch).toHaveBeenCalledTimes(1);
  needed = false;
  await act(hook.rerender);
  needed = 1;
  await act(hook.rerender);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  await act(() => hook.result.current.action('refresh', { k: 'recall' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  needed = 2;
  await act(hook.rerender);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
});

function readReceiptHarness() {
  const source = readFileSync('src/pdl/PdlAppHost.tsx', 'utf8');
  const effect = source.split('  const messageCount = history.messages.length;')[1].split('\n  const patchThread =')[0];
  return new Function(
    'useEffect',
    'history',
    'exportMids',
    'documentVisible',
    'engineMounted',
    'need',
    'request',
    'threadId',
    'notifyHandledMentionRead',
    'invalidateSidebarProjection',
    'useSidebarProjectionStore',
    transpileModule('const messageCount = history.messages.length;' + effect, {
      compilerOptions: { target: ScriptTarget.ES2022 },
    }).outputText,
  );
}

it('skips a full sidebar read for no-op acknowledgements and refreshes on advance', async () => {
  const readReceipt = readReceiptHarness();
  const notify = vi.fn(),
    invalidate = vi.fn(async () => true);
  let advanced = false;
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({ caughtUp: true, advanced, handledMention: false, messageId: 'latest' }),
  );
  let messages: ReturnType<typeof fixtureData>['messages'] = [],
    needed: number | false = false;
  const hook = renderHook(() =>
    readReceipt(useEffect, { messages }, undefined, true, true, () => needed, request, 'thread', notify, invalidate, {
      getState: () => ({ rows: [] }),
    }),
  );
  expect(apiFetch).not.toHaveBeenCalled();
  needed = 1;
  await act(hook.rerender);
  await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  expect(invalidate).not.toHaveBeenCalled();

  advanced = true;
  messages = fixtureData().messages;
  await act(hook.rerender);
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  expect(notify).toHaveBeenCalledTimes(2);
});

it('keeps the canonical read when an acknowledgement is not caught up', async () => {
  const readReceipt = readReceiptHarness();
  const notify = vi.fn(),
    invalidate = vi.fn(async () => true);
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({ caughtUp: false, messageId: 'latest' }));
  let needed: number | false = 1;
  renderHook(() =>
    readReceipt(
      useEffect,
      { messages: fixtureData().messages },
      undefined,
      true,
      true,
      () => needed,
      request,
      'thread',
      notify,
      invalidate,
      { getState: () => ({ rows: [] }) },
    ),
  );
  await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  needed = false;
});

it('keeps the sidebar source through conversation changes and re-pulls it only on an explicit invalidation', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/threads?view=sidebar') return Response.json({ threads: [] });
    if (path === '/api/labels') return Response.json([]);
    if (path === '/api/config/thread-attention') return Response.json({ groups: [], open: {} });
    throw new Error('Unexpected source read: ' + path);
  });
  let data = fixtureData();
  const hook = renderHook(() => useSidebarBindings(data, 1));
  const reads = () => vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/threads?view=sidebar');
  await waitFor(() => expect(reads()).toHaveLength(1));
  data = { ...data, threadId: 'another-thread', messages: [] };
  await act(hook.rerender);
  data = { ...data, messages: fixtureData().messages };
  await act(hook.rerender);
  expect(reads()).toHaveLength(1);
  await act(invalidateSidebarProjection);
  expect(reads()).toHaveLength(2);
  expect(reads().every(([, init]) => init?.method === undefined || init.method === 'GET')).toBe(true);
});

it('shares uncertain approval and explicit readback between inbox and native cards, then reads back sidebar Group placement', async () => {
  const target: ProposalTarget = {
    feature: 'F128',
    id: 'shared-proposal',
    threadId: 'source',
    mid: 'card',
    blockId: 'block',
  };
  let approved = false,
    attempts = 0;
  const proposal = () => ({
    proposalId: target.id,
    status: approved ? 'approved' : 'pending',
    sourceThreadId: target.threadId,
    sourceCatId: 'codex',
    cardMessageId: target.mid,
    title: 'Task',
    reason: 'Separate work',
    parentThreadId: 'source',
    preferredCats: ['codex'],
    projectPath: '/project',
    createdBy: 'owner',
    createdAt: 1,
    ...(approved ? { createdThreadId: 'created', attentionGroupId: 'group' } : {}),
  });
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.endsWith('/approve') && init?.method === 'POST') {
      if (++attempts === 1) throw new Error('unknown result');
      approved = true;
      return Response.json({ status: 'approved', threadId: 'created' });
    }
    if (path === '/api/proposals/shared-proposal') return Response.json({ proposal: proposal() });
    if (path === '/api/config/thread-attention')
      return Response.json({ groups: approved ? [{ id: 'group', threadIds: ['created'] }] : [] });
    if (path === '/api/labels') return Response.json([]);
    return Response.json({ threads: [] });
  });
  const oldHub = useApprovalHubStore.getState();
  useApprovalHubStore.setState({
    ensurePending: vi.fn(async () => {}),
    items: [
      {
        proposalId: target.id,
        sourceFeatureId: 'F128',
        requesterCatId: 'codex',
        ownerUserId: 'owner',
        summary: 'Task',
        detail: {},
        navigation: anchoredApprovalNavigation('source', { cardMessageId: 'card' }),
        inlineApprovable: true,
        resolution: 'open',
        materialization: { state: 'not_started' },
        createdAt: 1,
      },
    ],
  });
  try {
    let native!: ProposalBinding;
    const changed = (binding: ProposalBinding) => {
      native = binding;
    };
    renderHook(
      () => null,
      () => <ProposalRecordBinding target={target} generation={1} changed={changed} />,
    );
    const inbox = renderHook(() => useMessageSourceBindings(fixtureData()));
    const sidebar = renderHook(() => useSidebarBindings(fixtureData(), true));
    await waitFor(() => expect(native?.record).toBeDefined());
    await act(async () => {
      await expect(
        inbox.result.current.action('inboxDecide', { id: target.id, owner: 'owner', res: 'accept' }),
      ).rejects.toThrow('unknown result');
    });
    expect(proposalView(native, false, false, {})).toMatchObject({ recovery: 'uncertain', canApprove: false });
    await act(() => window.dispatchEvent(new Event('focus')));
    expect(proposalView(native, false, false, {})).toMatchObject({ recovery: 'uncertain', canApprove: false });
    await act(async () => {
      await expect(
        inbox.result.current.action('inboxDecide', { id: target.id, owner: 'owner', res: 'accept' }),
      ).rejects.toThrow('proposalRecovery.blocked');
    });
    expect(attempts).toBe(1);
    await act(() => recheckProposal(native));
    expect(proposalView(native, false, false, {})?.canApprove).toBe(true);
    await act(() => inbox.result.current.action('inboxDecide', { id: target.id, owner: 'owner', res: 'accept' }));
    expect(attempts).toBe(2);
    expect(proposalView(native, false, false, {})).toMatchObject({
      recovery: 'placement',
      canApprove: false,
      openId: 'created',
    });
    expect(sidebar.result.current.data.owner?.preferences.groups).toMatchObject([
      { id: 'group', threadIds: ['created'] },
    ]);
    expect(inbox.result.current.data.inboxRecoveries?.[target.id]?.phase).toBe('placement');
    await act(() => inbox.result.current.action('inboxReadback', { id: target.id }));
    expect(attempts).toBe(2);
  } finally {
    useApprovalHubStore.setState(oldHub);
  }
});
