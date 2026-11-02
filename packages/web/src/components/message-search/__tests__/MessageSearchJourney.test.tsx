import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { ContextAttachmentList } from '../../ContextAttachmentView';
import { ShellPresentationContext } from '../../shell/shell-presentation';
import { addQuoteToChat } from '../../workspace/workspace-file-quote';
import { MessageSearchResults } from '../MessageSearchResults';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ cats: [], getCatById: () => undefined }) }));
vi.mock('../../workspace/workspace-file-quote', () => ({ addQuoteToChat: vi.fn(() => ({ kind: 'added' })) }));
const decision = {
  status: 'decided' as const,
  conclusion: '侧栏标题不改成一行，最多两行',
  featureId: 'F322',
  documentPath: 'docs/features/F322-example.md',
  documentRevision: 'revision',
  line: 314,
  decidedBy: 'You',
  decidedAt: '10-15 09:08',
};
const hit: MessageSearchResult = {
  threadId: 'source',
  messageId: 'original',
  threadTitle: '设计指挥',
  speaker: 'user',
  timestamp: 1792080484605,
  timelineOrderAt: 1792080484605,
  snippet: { text: '不要一行。', start: 2, end: 7, source: 'body' },
  highlights: [{ start: 2, end: 4 }],
  match: 'lexical',
  contentRevision: 'original-revision',
  publiclyQuotable: true,
  decisionSources: [decision],
};
const canonical = {
  threadId: 'source',
  messageId: 'original',
  content: '我们这个不是定过？不要一行这种。',
  speaker: 'user',
  timestamp: hit.timestamp,
  contentRevision: hit.contentRevision,
  truncated: false,
};
const source = {
  status: 'available',
  target: { threadId: 'source', messageId: 'original', contentRevision: hit.contentRevision },
  updated: false,
  message: canonical,
  following: [{ ...canonical, messageId: 'after', speaker: 'codex61-sol', content: '后面真实接着的一条。' }],
};
function response(searchId = 'search'): MessageSearchResponse {
  return {
    searchId,
    query: '一行',
    results: [
      hit,
      {
        ...hit,
        messageId: 'unregistered',
        decisionSources: undefined,
        snippet: { text: '正文自己说已定，不应贴标签。', start: 0, end: 15, source: 'body' },
      },
    ],
    meta: {
      scope: 'global',
      sort: 'time',
      requestedMode: 'hybrid',
      effectiveMode: 'lexical',
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
}
let host: HTMLDivElement;
let root: Root;
let navigate: ReturnType<typeof vi.fn<(result: MessageSearchResult, response: MessageSearchResponse) => void>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  navigate = vi.fn();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(addQuoteToChat).mockClear();
  useChatStore.setState({ currentThreadId: 'current' });
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      ({
        ok: true,
        json: async () => ({
          ...source,
          following:
            new URL(String(url), 'https://example.test').searchParams.get('contextCount') === '0'
              ? []
              : source.following,
        }),
      }) as Response,
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
async function render(searchId = 'search') {
  await act(async () =>
    root.render(
      <MessageSearchResults
        currentThreadId="current"
        status="ready"
        response={response(searchId)}
        onNavigate={navigate}
        journey6
        resolveSpeaker={(s) => (s === 'user' ? 'You' : s)}
      />,
    ),
  );
}
function button(text: string) {
  const scope = text.includes('看已定事项') ? host : host.querySelector('[data-message-search-result]');
  const found = [...(scope?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) =>
    b.textContent?.includes(text),
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

function expandButton() {
  const found = host.querySelector<HTMLButtonElement>('[aria-label="展开前后文：第1处"]');
  if (!found) throw new Error('Missing first expansion');
  return found;
}

test('one result renderer shows only declared ledger labels and expands canonical successors without another search or navigation', async () => {
  await render();
  expect(host.querySelector('[aria-label="定下来的"]')?.textContent).toContain('侧栏标题不改成一行，最多两行');
  expect(host.querySelectorAll('[data-message-decision-label]')).toHaveLength(1);
  expect(host.querySelector('mark')?.textContent).toBe('一行');
  await act(async () => expandButton().click());
  expect(host.querySelector('[data-message-search-context]')?.textContent).toContain(canonical.content);
  expect(host.querySelector('[data-message-search-context]')?.textContent).toContain('后面真实接着的一条');
  expect(navigate).not.toHaveBeenCalled();
  expect(
    vi.mocked(apiFetch).mock.calls.every(([url]) => String(url).startsWith('/api/evidence/navigation-source?')),
  ).toBe(true);
});

test('quote admits freshly read original text and source into the current composer, not its search snippet', async () => {
  await render();
  await act(async () => expandButton().click());
  await act(async () => button('引用到聊天').click());
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(addQuoteToChat).toHaveBeenCalledWith(
    'current',
    expect.objectContaining({
      kind: 'quote',
      text: canonical.content,
      source: expect.objectContaining({
        kind: 'message',
        threadId: 'source',
        messageId: 'original',
        displayLabel: expect.stringContaining('已定'),
      }),
    }),
  );
  expect(vi.mocked(addQuoteToChat).mock.calls[0][1]).not.toHaveProperty('comment');
  expect(button('已引用')).toBeDefined();
  expect(navigate).not.toHaveBeenCalled();
});

test('a source withdrawn after expansion is re-admitted before quoting and cannot insert a cached body', async () => {
  await render();
  await act(async () => expandButton().click());
  vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 403 } as Response);
  await act(async () => button('引用到聊天').click());
  expect(addQuoteToChat).not.toHaveBeenCalled();
  expect(host.textContent).toContain('不可访问');
});

test('late expanded bodies cannot cross a new query generation with the same message coordinate', async () => {
  let complete!: (r: Response) => void;
  vi.mocked(apiFetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  await act(async () => expandButton().click());
  await render('another-query');
  await act(async () => complete({ ok: true, json: async () => source } as Response));
  expect(host.querySelector('[data-message-search-context]')).toBeNull();
  expect(addQuoteToChat).not.toHaveBeenCalled();
});

test('the quote carries the freshly read author and refuses a truncated original instead of silently clipping it', async () => {
  await render();
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      ...source,
      following: [],
      message: { ...canonical, speaker: 'codex61-sol', truncated: true },
    }),
  } as Response);
  await act(async () => button('引用到聊天').click());
  expect(addQuoteToChat).not.toHaveBeenCalled();
  expect(host.textContent).toContain('原文较长');
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ ...source, following: [], message: { ...canonical, speaker: 'codex61-sol' } }),
  } as Response);
  await act(async () => button('引用到聊天').click());
  expect(addQuoteToChat).toHaveBeenCalledWith(
    'current',
    expect.objectContaining({
      source: expect.objectContaining({
        senderCatId: 'codex61-sol',
        displayLabel: expect.stringContaining('codex61-sol'),
      }),
    }),
  );
});

test('look at the decision uses the existing file resolver and scoped Workbench action', async () => {
  await render();
  const open = vi.spyOn(useChatStore.getState(), 'openWorkspacePath').mockReturnValue(true);
  const reference = `${decision.documentPath}:${decision.line}`;
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      groups: [
        {
          threadId: 'source',
          results: [
            {
              reference,
              target: {
                kind: 'file',
                entryType: 'file',
                worktreeId: 'verified-root',
                path: decision.documentPath,
                line: decision.line,
                absolutePath: `/verified/${decision.documentPath}`,
                mime: 'text/markdown',
                size: 1,
                modifiedAt: '2026-10-26',
              },
            },
          ],
        },
      ],
    }),
  } as Response);
  await act(async () => button('看已定事项').click());
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/workspace/chat-references',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ groups: [{ threadId: 'source', references: [reference] }] }),
    }),
  );
  expect(open).toHaveBeenCalledWith('current', {
    kind: 'file',
    path: decision.documentPath,
    line: decision.line,
    worktreeId: 'verified-root',
  });
  open.mockRestore();
});

test('source attribution is visible on the existing quote chip, with no synthetic user comment and no classic redesign', async () => {
  const displayLabel = 'You · 2026/10/15 09:08 · 已定';
  const attachment = {
    v: 1,
    id: 'source-attribution',
    kind: 'quote',
    text: canonical.content,
    source: { kind: 'message', threadId: 'source', messageId: 'original', displayLabel },
  } as const;
  await act(async () =>
    root.render(
      <ShellPresentationContext.Provider value="v2">
        <ContextAttachmentList attachments={[attachment]} compact onRemove={() => {}} />
      </ShellPresentationContext.Provider>,
    ),
  );
  expect(host.textContent).toContain(displayLabel);
  expect(host.querySelector('[data-testid="context-annotations-summary"]')).toBeNull();
  await act(async () =>
    root.render(
      <ShellPresentationContext.Provider value="classic">
        <ContextAttachmentList attachments={[attachment]} compact onRemove={() => {}} />
      </ShellPresentationContext.Provider>,
    ),
  );
  expect(host.textContent).toContain('Message quote');
  expect(host.textContent).not.toContain(displayLabel);
});
