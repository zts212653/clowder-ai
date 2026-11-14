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

it('keeps quoted material, publisher comment and the selecting cat judgment visibly distinct', async () => {
  const text = '建议只在测试全部通过后，才下线判官。';
  const selected: MessageSearchResponse = {
    ...response,
    results: [
      {
        ...response.results[0],
        match: 'selected',
        selection: {
          v: 1,
          reason: 'co-creator已拍板立即下线判官',
          quote: '下线判官',
          part: { kind: 'quote', blockIndex: 0 },
          range: { start: text.indexOf('下线判官'), end: text.indexOf('下线判官') + 4 },
          sourceDigest: 'a'.repeat(64),
          headingPath: ['历史备选（未采用）'],
          context: {
            text,
            start: 0,
            end: text.length,
            quoteStart: text.indexOf('下线判官'),
            quoteEnd: text.indexOf('下线判官') + 4,
            truncatedBefore: false,
            truncatedAfter: false,
          },
          quotation: { text, truncated: false },
          comment: { text: '这版还不直接当合同。', truncated: false },
        },
      },
    ],
    meta: {
      ...response.meta,
      sort: 'selected',
      requestedMode: 'selected',
      effectiveMode: 'selected',
      resultKind: 'selected-answer',
      answerSelection: { v: 1, catId: 'codex61-sol', requested: 1 },
    },
  };
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({
      status: 'available',
      publicationRef: `message-search-answer:${'a'.repeat(64)}`,
      response: selected,
    }),
  );
  await act(async () => root.render(<RichBlockRenderer block={block} messageId="actual-message" />));
  expect(host.textContent).toContain('由 codex61-sol 选出 1 处来源');
  expect(host.textContent).toContain('co-creator引用了材料');
  expect(host.textContent).toContain('未核实原出处作者');
  expect(host.textContent).toContain('历史备选（未采用）');
  expect(host.textContent).toContain('建议只在测试全部通过后，才下线判官。');
  expect(host.textContent).toContain('co-creator 当条批注：「这版还不直接当合同。」');
  expect(host.textContent).toContain('codex61-sol 选用理由：co-creator已拍板立即下线判官');
  expect(host.querySelector('mark')?.textContent).toBe('下线判官');
  expect(host.querySelector('[aria-label="定下来的"]')).toBeNull();
  expect(host.textContent).not.toContain('本次结果中最早');
  const quote = [...host.querySelectorAll('button')].find((button) => button.textContent === '引用到聊天');
  await act(async () => quote?.click());
  const attachment = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
  expect(attachment?.kind).toBe('quote');
  if (attachment?.kind !== 'quote' || attachment.source.kind !== 'message') throw new Error('missing composer quote');
  expect(attachment.text).toContain('未核实原出处作者');
  expect(attachment.text).toContain('建议只在测试全部通过后，才下线判官。');
  expect(attachment.text).toContain('co-creator 当条批注：「这版还不直接当合同。」');
  expect(attachment.source.displayLabel).toContain('结构化摘录');
  expect(attachment.comment).toBeUndefined();
  expect(vi.mocked(apiFetch).mock.calls.every(([url]) => url.startsWith('/api/evidence/answer?'))).toBe(true);
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellPresentation('v2');
  useChatStore.setState({ currentThreadId: 'origin', threads: [], messages: [], pendingChatInsert: null });
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
