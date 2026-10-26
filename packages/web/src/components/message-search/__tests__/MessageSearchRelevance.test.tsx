import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { addQuoteToChat } from '../../workspace/workspace-file-quote';
import { MessageSearchResults } from '../MessageSearchResults';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../../workspace/workspace-file-quote', () => ({ addQuoteToChat: vi.fn(() => ({ kind: 'added' })) }));

const title = '侧栏对话标题不改成一行，标题最多两行';
const unrelated = '托付邀请不进待办，留在原对话';
const fact = {
  status: 'decided' as const,
  conclusion: title,
  featureId: 'F322',
  documentPath: 'docs/features/F322-everyday-work-experience.md',
  documentRevision: 'frozen-ledger',
  line: 316,
};
const original = '进展已经先回给你了。\n\n其他界面工作。\n\n侧栏对话标题要一行，还是保留原来的写法？';
const hit: MessageSearchResult = {
  threadId: 'source',
  messageId: 'decision-source',
  threadTitle: '原设计讨论',
  speaker: 'user',
  timestamp: 1792080484605,
  timelineOrderAt: 1792080484605,
  snippet: { text: 'thread栏的ok', start: 0, end: 10, source: 'body' },
  highlights: [],
  match: 'semantic',
  contentRevision: 'source-revision',
  publiclyQuotable: true,
  decisionSources: [fact, { ...fact, line: 317, conclusion: unrelated }],
};
const response: MessageSearchResponse = {
  searchId: 'relevance',
  query: '一行',
  results: [
    hit,
    {
      ...hit,
      messageId: 'ordinary',
      decisionSources: undefined,
      snippet: { text: '标题要一行吗？', start: 0, end: 7, source: 'body' },
      highlights: [{ start: 3, end: 5 }],
    },
  ],
  meta: {
    scope: 'global',
    sort: 'time',
    requestedMode: 'hybrid',
    effectiveMode: 'hybrid',
    degraded: false,
    partial: false,
    hasMore: false,
    candidateLimit: 2000,
    semanticCandidatesLimited: false,
    sourceCoverage: 'unknown',
    freshness: 'unknown',
    response: { budgetChars: 24000, serializedChars: 1000, truncated: false, continuation: 'unavailable' },
  },
};
const source = {
  status: 'available',
  updated: false,
  target: { threadId: hit.threadId, messageId: hit.messageId, contentRevision: hit.contentRevision },
  message: {
    threadId: hit.threadId,
    messageId: hit.messageId,
    contentRevision: hit.contentRevision,
    content: original,
    speaker: hit.speaker,
    timestamp: hit.timestamp,
    truncated: false,
  },
  following: [],
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useChatStore.setState({ currentThreadId: 'current' });
  vi.mocked(addQuoteToChat).mockClear();
  vi.mocked(apiFetch)
    .mockReset()
    .mockResolvedValue({ ok: true, json: async () => source } as Response);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
async function render(value = response) {
  await act(async () =>
    root.render(
      <MessageSearchResults
        journey6
        status="ready"
        response={value}
        currentThreadId="current"
        onNavigate={vi.fn()}
        resolveSpeaker={(speaker) => speaker}
      />,
    ),
  );
}
function card() {
  return host.querySelector<HTMLElement>('[aria-label="定下来的"]');
}
function cardQuote() {
  const button = [...(card()?.querySelectorAll('button') ?? [])].find((node) => node.textContent === '引用到聊天');
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

test('a shared source does not match an unrelated conclusion; its source reason and ordinary keyword snippet remain distinct', async () => {
  await render();
  expect(card()?.textContent).toContain(title);
  expect(card()?.textContent).not.toContain(unrelated);
  const rows = host.querySelectorAll('[data-message-search-result]');
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain(`这是「${title}」这条决定的出处`);
  expect(rows[0].textContent).not.toContain('thread栏的ok');
  expect(rows[1].querySelector('mark')?.textContent).toBe('一行');
  expect(rows[1].textContent).not.toContain('决定的出处');
});

test('source-body hits and narrative metadata cannot create a decided card when no conclusion matches the query', async () => {
  await render({ ...response, query: '进展', results: [hit] });
  expect(card()).toBeNull();
  expect(host.querySelectorAll('[data-message-search-result]')).toHaveLength(1);
});

test('an expanded uniquely anchored original retains all paragraphs and highlights the admitted hit', async () => {
  const start = original.indexOf('一行');
  await render({
    ...response,
    results: [
      {
        ...hit,
        snippet: { text: original, start: 0, end: original.length, source: 'body' },
        highlights: [{ start, end: start + 2 }],
      },
    ],
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="展开前后文：第1处"]')?.click());
  const context = host.querySelector('[data-message-search-context]');
  expect(context?.textContent).toContain('进展已经先回给你了。');
  expect(context?.querySelector('mark')?.textContent).toBe('一行');
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

test('the expanded opening follows the result excerpt instead of an earlier unrelated use of the same word', async () => {
  const snippet = '侧栏对话标题要一行，还是保留原来的写法？';
  const content = `账号页只标一行。\n\n其他工作。\n\n${snippet}`;
  const start = snippet.indexOf('一行');
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      ...source,
      updated: true,
      target: { ...source.target, contentRevision: 'new-revision' },
      message: { ...source.message, content, contentRevision: 'new-revision' },
    }),
  } as Response);
  await render({
    ...response,
    results: [
      {
        ...hit,
        snippet: { text: snippet, start: 0, end: snippet.length, source: 'body' },
        highlights: [{ start, end: start + 2 }],
      },
    ],
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="展开前后文：第1处"]')?.click());
  const focus = host.querySelector('[data-message-search-context] [data-message-search-focus]');
  expect(focus?.textContent).toBe('一行');
  expect(focus?.closest('[data-source-paragraph]')?.textContent).toBe(snippet);
});

test.each([
  'semantic-no-highlight',
  'updated-excerpt-missing',
  'updated-excerpt-repeated',
])('an unanchored %s source remains readable without guessing a literal hit or moving the popover', async (kind) => {
  const snippet = '侧栏对话标题要一行，还是保留原来的写法？';
  const content =
    kind === 'updated-excerpt-repeated'
      ? `账号页只标一行。\n\n${snippet}\n\n${snippet}`
      : '账号页只标一行。\n\n这条消息的其他工作。';
  const start = snippet.indexOf('一行');
  host.setAttribute('data-message-search-scroll', '');
  const scroll = vi.fn();
  host.scrollTo = scroll;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this === host ? 100 : 700;
    return { top, bottom: top + 100, height: 100, left: 0, right: 500, width: 500, x: 0, y: top, toJSON: () => ({}) };
  });
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      ...source,
      updated: kind !== 'semantic-no-highlight',
      target: {
        ...source.target,
        contentRevision: kind === 'semantic-no-highlight' ? hit.contentRevision : 'new-revision',
      },
      message: {
        ...source.message,
        content,
        contentRevision: kind === 'semantic-no-highlight' ? hit.contentRevision : 'new-revision',
      },
    }),
  } as Response);
  await render({
    ...response,
    results: [
      {
        ...hit,
        snippet: { text: snippet, start: 0, end: snippet.length, source: 'body' },
        highlights: kind === 'semantic-no-highlight' ? [] : [{ start, end: start + 2 }],
      },
    ],
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="展开前后文：第1处"]')?.click());
  expect(host.querySelector('[data-message-search-context]')?.textContent).toContain(content);
  expect(scroll).not.toHaveBeenCalled();
  expect(host.querySelector('[data-message-search-context] mark')).toBeNull();
});

test('v2 coverage is one plain paragraph and preserves unknown freshness and known omissions', async () => {
  await render();
  expect(host.querySelectorAll('[role="note"] p')).toHaveLength(1);
  expect(host.querySelector('[role="note"]')?.textContent).toContain('还不能确认');
  expect(host.querySelector('[role="note"]')?.textContent).not.toContain('还没进索引');
  await render({ ...response, meta: { ...response.meta, hasMore: true } });
  expect(host.querySelector('[role="note"]')?.textContent).toContain('只列出部分结果');
});

test('the decided card quotes its fresh canonical source through the existing composer and refuses withdrawal', async () => {
  await render();
  const button = cardQuote();
  vi.mocked(apiFetch).mockResolvedValueOnce({ ok: false, status: 403 } as Response);
  await act(async () => button.click());
  expect(addQuoteToChat).not.toHaveBeenCalled();
  expect(card()?.textContent).toContain('不可访问');
  await act(async () => button.click());
  expect(apiFetch).toHaveBeenLastCalledWith(expect.stringContaining('contextCount=0'), expect.anything());
  expect(addQuoteToChat).toHaveBeenCalledWith(
    'current',
    expect.objectContaining({
      kind: 'quote',
      text: original,
      source: expect.objectContaining({ threadId: hit.threadId, messageId: hit.messageId }),
    }),
  );
  expect(vi.mocked(addQuoteToChat).mock.calls[0][1]).not.toHaveProperty('comment');
});

test('a late decided-card quote cannot cross a new search generation or a foreground conversation change', async () => {
  let complete!: (response: Response) => void;
  await render();
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await act(async () => cardQuote().click());
  await render({ ...response, searchId: 'new-search' });
  await act(async () => complete({ ok: true, json: async () => source } as Response));
  expect(addQuoteToChat).not.toHaveBeenCalled();
  useChatStore.setState({ currentThreadId: 'another-thread' });
  await act(async () => cardQuote().click());
  expect(addQuoteToChat).not.toHaveBeenCalled();
  expect(card()?.textContent).toContain('当前对话已改变');
});
