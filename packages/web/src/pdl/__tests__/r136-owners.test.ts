import { ContextAttachmentsSchema } from '@cat-cafe/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { executeRecoveryOperation } from '@/components/cloud-binding-recovery-operations';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import { apiFetch } from '@/utils/api-client';
import { unboundTurn } from '../../../test/browser/fixtures/f247-unbound-turn';
import { chatModels } from '../chat-models';
import { cloudRecoveryTargets } from '../cloud-models';
import { useMessageSourceBindings } from '../useMessageSourceBindings';
import { useReviewBindings } from '../useReviewBindings';
import { useSidebarBindings } from '../useSidebarBindings';
import { fixtureData, fixtureUi } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner, useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: () => ({ works: [], loading: false, error: false }),
}));
vi.mock('@/hooks/useGlobalArtifacts', () => ({
  useGlobalArtifacts: () => ({ artifacts: [], loading: false, error: false, workLineage: 'resolved', complete: true }),
}));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({
  invalidateSidebarProjection: vi.fn(async () => true),
  refreshSidebarThreadSnapshot: vi.fn(async () => true),
}));
afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it('decides an inbox approval from another thread through the canonical producer writer', async () => {
  const previous = useApprovalHubStore.getState();
  useApprovalHubStore.setState({
    items: [
      {
        proposalId: 'remote-proposal',
        sourceFeatureId: 'F193',
        requesterCatId: 'codex',
        ownerUserId: 'owner',
        summary: 'Remote',
        detail: {},
        navigation: anchoredApprovalNavigation('remote-thread'),
        inlineApprovable: true,
        resolution: 'open',
        materialization: { state: 'not_started' },
        createdAt: 1,
      },
    ],
    pendingOwnerUserId: 'owner',
    pendingReadAvailable: true,
    isLoading: false,
  });
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ status: 'approved', threadId: 'remote-thread' }));
  try {
    const hook = renderHook(() => useMessageSourceBindings(fixtureData()));
    await act(() =>
      hook.result.current.action('inboxDecide', { id: 'remote-proposal', owner: 'owner', res: 'accept' }),
    );
    expect(apiFetch).toHaveBeenCalledWith('/api/dispatch-proposals/remote-proposal/approve', { method: 'POST' });
    expect(useApprovalHubStore.getState().decisionAttempts['remote-proposal'].state).toMatchObject({
      phase: 'response_received',
      ok: true,
    });
  } finally {
    useApprovalHubStore.setState(previous);
  }
});
it('generates suggestions without writes and accepts only the reviewed row using real label ids', async () => {
  const data = fixtureData();
  data.threads.push(
    { ...data.threads[0], id: 'second' },
    { ...data.threads[0], id: 'organizer', title: 'Thread 整理助手' },
  );
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/config/thread-attention') return Response.json({ groups: [], aliases: {}, open: {} });
    if (path === '/api/labels') return Response.json([{ id: 'native-label', name: 'Owner label', color: '#527b99' }]);
    if (path.startsWith('/api/messages?'))
      return Response.json({
        messages: [
          {
            catId: 'codex',
            timestamp: Date.now() + 1,
            content: '<!-- SUGGESTIONS_JSON:{"pdl-test":["native-label"],"second":["native-label"]} -->',
          },
        ],
      });
    return Response.json({ ok: true });
  });
  const hook = renderHook(() => useSidebarBindings(data, true));
  await waitFor(() => expect(hook.result.current.data.owner).not.toBeNull());
  let generate!: Promise<boolean>;
  await act(() => {
    generate = hook.result.current.action('clSuggest', {});
  });
  await act(async () => {
    // the organizer's reply reaches its terminal (pushed for any thread)
    window.dispatchEvent(
      new CustomEvent('cat-cafe:response-settled', {
        detail: { threadId: 'organizer', messageId: 'reply', catId: 'codex' },
      }),
    );
    await generate;
  });
  expect(hook.result.current.data.classification.phase).toBe('review');
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  await act(() => hook.result.current.action('clAccept', { ids: '["pdl-test"]' }));
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([, init]) => init?.method === 'PATCH')
      .map(([path, init]) => [path, JSON.parse(init!.body as string)]),
  ).toEqual([['/api/threads/pdl-test', { labels: ['native-label'] }]]);
  expect(hook.result.current.data.classification.suggestions.map((s) => [s.threadId, s.accepted])).toEqual([
    ['pdl-test', true],
    ['second', false],
  ]);
});
it('reads authoritative evidence and resolves a workspace file to its retained owner version', async () => {
  const data = fixtureData();
  data.messages[1].extra = {
    rich: {
      v: 1,
      blocks: [
        {
          v: 1,
          id: 'answer',
          kind: 'card',
          title: 'Untrusted display title',
          meta: { domain: 'message-search-answer' },
        },
        {
          v: 1,
          id: 'video',
          kind: 'file',
          fileName: 'film.mp4',
          url: '/api/workspace/file/raw?worktreeId=fixture&path=film.mp4',
        },
      ],
    },
  };
  const response = {
    searchId: 'search-1',
    query: 'Current owner query',
    results: [
      {
        threadId: 'source-thread',
        messageId: 'source-message',
        threadTitle: 'Source thread',
        speaker: 'codex',
        timestamp: 1,
        timelineOrderAt: 1,
        snippet: { text: 'Current source', start: 0, end: 14, source: 'body' },
        highlights: [],
        match: 'lexical',
        contentRevision: 'r1',
        publiclyQuotable: true,
      },
    ],
    meta: {
      scope: 'global',
      sort: 'time',
      requestedMode: 'lexical',
      effectiveMode: 'lexical',
      degraded: false,
      partial: false,
      hasMore: false,
      candidateLimit: 20,
      semanticCandidatesLimited: false,
      sourceCoverage: 'unknown',
      freshness: 'unknown',
      response: { budgetChars: 1000, serializedChars: 100, truncated: false, continuation: 'unavailable' },
    },
  };
  const artifact = {
    type: 'video',
    name: 'Verified film',
    catId: 'codex',
    createdAt: 1,
    sourceMessageId: 'reply-1',
    work: { contentRef: 'work:film', ownerRevision: 2, currentOwnerRevision: 3 },
  };
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    path.startsWith('/api/evidence/answer?')
      ? Response.json({ status: 'available', publicationRef: 'message-search-answer:' + 'a'.repeat(64), response })
      : Response.json({ artifact }),
  );
  const hook = renderHook(() => useMessageSourceBindings(data, true));
  await waitFor(() =>
    expect(projectOwner('sources', hook.result.current, {}, data, undefined).evidenceCards['reply-1']?.title).toBe(
      'Current owner query',
    ),
  );
  const vm = chatModels(data, fixtureUi(), { project: { sources: hook.result.current.data } }).chatStream.items[1];
  expect(vm).toMatchObject({
    kind: 'evidence',
    card: {
      title: 'Current owner query',
      fields: [{ act: 'msgJump', args: { t: 'source-thread', mid: 'source-message' } }],
    },
  });
  expect(JSON.parse(vm.embeds[0].rich.file!.work)).toEqual({
    threadId: data.threadId,
    contentRef: 'work:film',
    ownerRevision: 2,
  });
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/works/resolve-file?threadId=pdl-test&worktreeId=fixture&path=film.mp4',
    undefined,
    undefined,
  );
});
it('keeps generation source ids separate from read receipts, including unloaded and incomplete sources', async () => {
  const data = fixtureData();
  data.messages.push({
    id: 'connector-source',
    type: 'connector',
    content: 'Native external note',
    timestamp: 2,
    source: { connector: 'native', label: 'Native connector', icon: 'cloud' },
  });
  data.messages[1].lifecycle = {
    kind: 'response',
    orderKey: 'reply-1',
    invocationId: 'run-1',
    targetId: 'codex',
    inputEntryIds: [],
    inputMessageIds: ['user-1'],
    startedAt: 1,
    completedAt: 3,
    status: 'completed',
  };
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({
      messageIds: ['user-1', 'connector-source', 'older-source'],
      hasAppendedInputs: false,
      complete: true,
    }),
  );
  const hook = renderHook(() => useMessageSourceBindings(data, true));
  await waitFor(() =>
    expect(projectOwner('sources', hook.result.current, {}, data, undefined).generations['reply-1']?.complete).toBe(
      true,
    ),
  );
  const vm = chatModels(data, fixtureUi(), { project: { sources: hook.result.current.data } }).chatStream.items[1];
  expect(vm.supp).toMatchObject({
    count: 3,
    items: [
      { mid: 'user-1', state: 'unknown' },
      { mid: 'connector-source', name: 'Native connector', who: '', state: 'unknown' },
      { mid: 'older-source', unknown: true, state: 'unknown' },
    ],
  });
  expect(
    chatModels(data, fixtureUi(), {
      project: {
        sources: {
          error: null,
          records: {
            evidence: {},
            works: {},
            generations: { 'reply-1': { messageIds: [], complete: false, hasAppendedInputs: false } },
          },
        },
      },
    }).chatStream.items[1].supp,
  ).toBeNull();
});
it('binds a cat source using the existing binding writer without dispatching a retry', async () => {
  const turn = unboundTurn('cat');
  const target = cloudRecoveryTargets(turn, 'owner-thread')[0];
  expect(target).toMatchObject({ bindOnly: true, mid: turn[2].id, identity: { sourceMessageId: turn[0].id } });
  const chatUrl = 'https://chatgpt.com/c/owner-conversation';
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ bindings: { 'gpt-pro': chatUrl } }));
  const outcome = await executeRecoveryOperation({
    identity: target.identity,
    prepared: { chatUrl, routeIsBound: false },
    isCurrent: () => true,
    setPhase: vi.fn(),
    onBound: vi.fn(),
    onWriteStart: vi.fn(),
    onWriteSettled: vi.fn(),
  });
  expect(outcome).toEqual({ kind: 'connected' });
  expect(apiFetch).toHaveBeenCalledOnce();
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/threads/owner-thread/cloud-bindings',
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ catId: 'gpt-pro', chatUrl }) }),
  );
});
it('preserves the exact work version and CLI owner leaf in the existing send/read schema', () => {
  const contexts = [
    { v: 1, id: 'work-ref', kind: 'work', workId: 'content:owner-work', version: 2, title: 'Fixed version' },
    {
      v: 1,
      id: 'cli-ref',
      kind: 'quote',
      text: 'owner output',
      selectionStart: 0,
      selectionEnd: 12,
      source: {
        kind: 'cli_output',
        threadId: 'thread',
        messageId: 'reply',
        toolUseId: 'call',
        executionRef: 'run',
        part: 'result',
      },
    },
  ];
  expect(ContextAttachmentsSchema.parse(JSON.parse(JSON.stringify(contexts)))).toEqual(contexts);
});
it('opens the resolved work version through the existing owner without requiring a current catalogue row', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const revision = Number(new URL(path, 'https://api.test').searchParams.get('ownerRevision'));
    return Response.json({
      artifact: {
        type: 'video',
        name: 'Retained owner version ' + revision,
        catId: 'codex',
        sourceMessageId: 'source-reply',
        createdAt: 1,
        url: '/api/content-publications/work%3Aretained/media/' + revision,
        work: { contentRef: 'work:retained', ownerRevision: revision, currentOwnerRevision: 4 },
      },
    });
  });
  const ui = fixtureUi(),
    hook = renderHook(() =>
      useOwnerProjection('reviews', useReviewBindings('host-thread', ui, undefined, true), { ui }),
    );
  const reference = JSON.stringify({ threadId: 'host-thread', contentRef: 'work:retained', ownerRevision: 2 });
  await act(() => hook.result.current.action('workOpen', { i: reference, rev: '2' }));
  expect(hook.result.current.project().work?.title).toBe('Retained owner version 2');
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/works/resolve-file?threadId=host-thread&contentRef=work%3Aretained&ownerRevision=2',
    undefined,
    undefined,
  );
  await act(() => hook.result.current.action('workOpen', { i: reference, rev: '4' }));
  expect(hook.result.current.project().work?.title).toBe('Retained owner version 4');
});
it('keeps classification failure in the existing reader error state and retries without accepting suggestions', async () => {
  const data = fixtureData();
  data.threads.push({ ...data.threads[0], id: 'organizer', title: 'Thread 整理助手' });
  let failed = true;
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/config/thread-attention') return Response.json({ groups: [], aliases: {}, open: {} });
    if (path === '/api/labels') return Response.json([{ id: 'native-label', name: 'Owner label', color: '#527b99' }]);
    if (path === '/api/messages' && failed)
      return Response.json({ error: 'generation owner unavailable' }, { status: 503 });
    if (path.startsWith('/api/messages?'))
      return Response.json({
        messages: [
          {
            catId: 'codex',
            timestamp: Date.now() + 1,
            content: '<!-- SUGGESTIONS_JSON:{"pdl-test":["native-label"]} -->',
          },
        ],
      });
    return Response.json({ ok: true });
  });
  const hook = renderHook(() => useSidebarBindings(data, true));
  await waitFor(() => expect(hook.result.current.data.owner).not.toBeNull());
  await act(() => hook.result.current.action('clSuggest', {}));
  expect(hook.result.current.data.classification).toMatchObject({
    phase: 'review',
    error: 'generation owner unavailable',
    suggestions: [],
  });
  failed = false;
  let retry!: Promise<boolean>;
  await act(() => {
    retry = hook.result.current.action('clSuggest', {});
  });
  await act(async () => {
    // the organizer's reply reaches its terminal (pushed for any thread)
    window.dispatchEvent(
      new CustomEvent('cat-cafe:response-settled', {
        detail: { threadId: 'organizer', messageId: 'reply', catId: 'codex' },
      }),
    );
    await retry;
  });
  expect(hook.result.current.data.classification).toMatchObject({
    phase: 'review',
    error: '',
    suggestions: [{ threadId: 'pdl-test', accepted: false }],
  });
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
});
