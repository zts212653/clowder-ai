import type { MessageSearchResponse } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RichBlockRenderer } from '@/components/rich/RichBlockContent';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'http://local.test' }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [], getCatById: () => undefined, hasFetched: true, isLoading: false }),
  formatCatName: () => '猫',
}));
const fact = {
  status: 'decided' as const,
  conclusion: '一行标题的决定',
  featureId: 'F322',
  documentPath: 'docs/features/F322.md',
  documentRevision: 'a'.repeat(40),
  line: 1,
};
const response: MessageSearchResponse = {
  searchId: 'one-snapshot',
  query: '一行',
  results: [0, 1, 2, 3].map((n) => ({
    threadId: 'sources',
    messageId: `source-${n}`,
    threadTitle: '原对话',
    speaker: 'user',
    timestamp: 1000 + n,
    timelineOrderAt: 1000 + n,
    snippet: { text: `一行原文 ${n}`, start: 0, end: 6, source: 'body' },
    highlights: [{ start: 0, end: 2 }],
    match: 'lexical',
    contentRevision: 'revision',
    publiclyQuotable: true,
    ...(n === 2
      ? { decisionSources: [fact] }
      : n === 1
        ? { decisionSources: [{ ...fact, status: 'not-adopted' as const }] }
        : {}),
  })),
  meta: {
    scope: 'global',
    sort: 'time',
    requestedMode: 'hybrid',
    effectiveMode: 'hybrid',
    degraded: false,
    partial: true,
    hasMore: true,
    candidateLimit: 2000,
    semanticCandidatesLimited: false,
    sourceCoverage: 'unknown',
    freshness: 'unknown',
    response: { budgetChars: 24000, serializedChars: 1000, truncated: false, continuation: 'unavailable' },
  },
};
const block = {
  kind: 'card' as const,
  v: 1 as const,
  id: 'answer-block',
  title: 'FAKE CAT CONCLUSION',
  meta: { domain: 'message-search-answer', publicationRef: 'copied-ref', verified: true, response },
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellPresentation('v2');
  useChatStore.setState({ currentThreadId: 'origin', threads: [], messages: [] });
  vi.mocked(apiFetch)
    .mockReset()
    .mockResolvedValue(Response.json({ status: 'unavailable' }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('ignores hand-written verified/title/response and resolves by the actual message and block coordinates', async () => {
  await act(async () => root.render(<RichBlockRenderer block={block} messageId="actual-message" />));
  expect(host.textContent).not.toContain('FAKE CAT CONCLUSION');
  expect(host.textContent).not.toContain('一行原文');
  expect(host.textContent).toContain('来源卡暂不可用');
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/evidence/answer?messageId=actual-message&blockId=answer-block',
    expect.anything(),
  );
});
it('shows at most three server sources by declared status, and opens the full same snapshot without search', async () => {
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({
      status: 'available',
      publicationRef: `message-search-answer:${'a'.repeat(64)}`,
      response,
      createdAt: 1,
    }),
  );
  const open = vi.fn();
  window.addEventListener('cat-cafe:message-find-open', open);
  try {
    await act(async () => root.render(<RichBlockRenderer block={block} messageId="actual-message" />));
    const rows = [...host.querySelectorAll('[data-message-search-result]')];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('一行原文 2'),
      expect.stringContaining('一行原文 1'),
      expect.stringContaining('一行原文 0'),
    ]);
    expect(host.querySelector('[aria-label="定下来的"]')).not.toBeNull();
    const all = [...host.querySelectorAll('button')].find((button) => button.textContent === '在查找里看全部 ›');
    await act(async () => all?.click());
    expect(open).toHaveBeenCalledOnce();
    expect((open.mock.calls[0][0] as CustomEvent).detail.response).toEqual(response);
    expect(vi.mocked(apiFetch).mock.calls.every(([url]) => url.startsWith('/api/evidence/answer?'))).toBe(true);
  } finally {
    window.removeEventListener('cat-cafe:message-find-open', open);
  }
});
it('does not recover a message coordinate from untrusted card meta', async () => {
  await act(async () =>
    root.render(<RichBlockRenderer block={{ ...block, meta: { ...block.meta, messageId: 'stolen-message' } }} />),
  );
  expect(apiFetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain('来源卡暂不可用');
});
it('re-admits the original message binding before a quote action and drops a withdrawn card without reading its source', async () => {
  let withdrawn = false;
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json(
      withdrawn
        ? { status: 'unavailable' }
        : { status: 'available', publicationRef: `message-search-answer:${'a'.repeat(64)}`, response },
    ),
  );
  await act(async () => root.render(<RichBlockRenderer block={block} messageId="actual-message" />));
  const row = host.querySelector('[data-message-search-result]');
  const quote = [...(row?.querySelectorAll('button') ?? [])].find((button) => button.textContent === '引用到聊天');
  expect(quote).toBeDefined();
  withdrawn = true;
  await act(async () => quote?.click());
  expect(host.textContent).toContain('来源卡暂不可用');
  expect(vi.mocked(apiFetch).mock.calls).toHaveLength(2);
  expect(vi.mocked(apiFetch).mock.calls.every(([url]) => url.startsWith('/api/evidence/answer?'))).toBe(true);
});
