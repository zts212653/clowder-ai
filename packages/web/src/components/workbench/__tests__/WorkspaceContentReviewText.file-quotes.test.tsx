import type { WorkspaceFileQuotePage, WorkspaceFileQuoteReference } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceContentReviewText } from '../content-review/WorkspaceContentReviewText';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), open: vi.fn() }));
vi.mock('@/utils/api-client', async (original) => ({
  ...(await original<typeof import('@/utils/api-client')>()),
  apiFetch: (...args: unknown[]) => mocks.fetch(...args),
}));
vi.mock('@/components/shell/mailbox/open-exact-place', () => ({
  openExactPlace: (...args: unknown[]) => mocks.open(...args),
}));
vi.mock('@/components/workspace/useWorkspaceListenMode', () => ({
  useWorkspaceListenMode: () => ({ active: false, sentences: [], hasSentences: false }),
}));
vi.mock('@/components/workspace/WorkspaceListenActions', () => ({ WorkspaceListenActions: () => null }));
const revision: `sha256:${string}` = `sha256:${'a'.repeat(64)}`;
const reference = (
  state: WorkspaceFileQuoteReference['state'],
  messageId: string = state,
): WorkspaceFileQuoteReference => ({
  messageId,
  threadId: 'source-thread',
  authorCatId: 'codex-astra',
  timestamp: 1,
  quoteNumber: 2,
  state,
  attachment: {
    v: 1,
    id: `quote-${messageId}`,
    kind: 'quote',
    text: 'Second paragraph.',
    source: {
      kind: 'workspace_file',
      worktreeId: 'work',
      path: 'guide.md',
      ...(state === 'unversioned' ? {} : { revision }),
    },
  },
  ...(state === 'current' ? { anchor: { start: 19, end: 36, quote: 'Second paragraph.' } } : {}),
});
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  mocks.fetch.mockReset();
  mocks.open.mockReset();
  useChatStore.setState({ currentThreadId: 'here', messages: [], rightPanelOpen: true });
  useChatStore.setState({ pendingChatInsert: null });
  syncContextAttachmentDraftToStorage('here', []);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const render = async (value = revision, path = 'guide.md') => {
  await act(async () =>
    root.render(
      <WorkspaceContentReviewText
        text={'First paragraph.\n\nSecond paragraph.'}
        revision={value}
        locator={{ worktreeId: 'work', path }}
        markdown
        onQuoteSelected={vi.fn()}
      />,
    ),
  );
};

it('reads file references without prepare, preserves authors and drift, and returns to the exact quoted message', async () => {
  const page: WorkspaceFileQuotePage = {
    sourceRevision: revision,
    quotes: [reference('current'), reference('changed'), reference('unversioned')],
  };
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify(page)));
  await render();
  expect(mocks.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/workspace/file-quotes?'))).toBe(true);
  expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes('/prepare'))).toBe(false);
  expect(container.textContent).toContain('引用消息 3');
  expect(container.textContent).toContain('原文已改');
  expect(container.textContent).toContain('无法确认当前位置');
  expect(container.querySelectorAll('[data-file-quote-reference]')).toHaveLength(3);
  expect(container.querySelectorAll('[data-file-quote-state="current"]')).toHaveLength(1);
  const button = container.querySelector<HTMLButtonElement>('[data-file-quote-reference="quote-current"]');
  await act(async () => button?.click());
  expect(mocks.open).toHaveBeenCalledWith('message:source-thread:current', window.location.pathname);
  expect(useChatStore.getState().rightPanelOpen).toBe(false);
  expect(useF307ExperienceWorkbenchStore.getState().mainAreaAttentionSurfaceId).toBeNull();
});

it('does not attach a late answer for another file to the current document', async () => {
  let finish: (response: Response) => void = () => {};
  mocks.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ sourceRevision: revision, quotes: [] })));
  await render();
  await render(revision, 'other.md');
  await act(async () =>
    finish(new Response(JSON.stringify({ sourceRevision: revision, quotes: [reference('current')] }))),
  );
  expect(container.querySelector('[data-file-quote-reference]')).toBeNull();
});

it('refuses to locate references after the file version changed or access was revoked', async () => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'revision_changed' } }), { status: 409 }));
  await render();
  expect(container.textContent).toContain('原文已改');
  expect(container.querySelector('[data-file-quote-reference]')).toBeNull();
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'access_denied' } }), { status: 403 }));
  await render(revision, 'other.md');
  expect(container.textContent).toContain('无法读取引用消息');
  expect(container.querySelector('[data-file-quote-reference]')).toBeNull();
});

it('groups two references of the same rendered passage into one reachable gutter mark', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.sourceLine
      ? new DOMRect(0, 160, 300, 20)
      : this.dataset.testid === 'workspace-content-review-text'
        ? new DOMRect(0, 80, 300, 400)
        : new DOMRect(0, 0, 300, 500);
  });
  mocks.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({ sourceRevision: revision, quotes: [reference('current', 'one'), reference('current', 'two')] }),
    ),
  );
  await render();
  expect(container.querySelectorAll('[data-file-quote-mark]')).toHaveLength(1);
  const mark = container.querySelector<HTMLButtonElement>('[data-file-quote-mark]');
  expect(mark?.textContent).toContain('2');
  await act(async () => mark?.click());
  expect(container.querySelector('details')?.open).toBe(true);
  expect(mocks.open).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-file-quote-reference="quote-two"]')?.click());
  expect(mocks.open).toHaveBeenCalledWith('message:source-thread:two', window.location.pathname);
});

it('refreshes a callback quote merged into the same message and removes it after recall, without reading every text token', async () => {
  const message = { id: 'cat', type: 'assistant' as const, content: '正文', timestamp: 1 };
  useChatStore.setState({ messages: [message] });
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ sourceRevision: revision, quotes: [] })));
  await render();
  const initial = mocks.fetch.mock.calls.length;
  await act(async () => useChatStore.setState({ messages: [{ ...message, content: '正文继续' }] }));
  expect(mocks.fetch).toHaveBeenCalledTimes(initial);
  const attachment = reference('current').attachment;
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ sourceRevision: revision, quotes: [reference('current')] })),
  );
  await act(async () =>
    useChatStore.setState({ messages: [{ ...message, contentBlocks: [{ type: 'context_attachment', attachment }] }] }),
  );
  expect(container.querySelector('[data-file-quote-reference]')).not.toBeNull();
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ sourceRevision: revision, quotes: [] })));
  await act(async () =>
    useChatStore.setState({
      messages: [
        {
          ...message,
          contentBlocks: [{ type: 'context_attachment', attachment }],
          extra: { recall: { version: 1, exposure: 'none', recalledAt: 2 } },
        },
      ],
    }),
  );
  expect(container.querySelector('[data-file-quote-reference]')).toBeNull();
});

it('projects the same composer numbers for queued and consumed unsent quotes without creating owner records', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.sourceLine
      ? new DOMRect(0, Number(this.dataset.sourceLine) * 40 + 100, 300, 20)
      : this.dataset.testid === 'workspace-content-review-text'
        ? new DOMRect(0, 80, 300, 400)
        : new DOMRect(0, 0, 300, 500);
  });
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ sourceRevision: revision, quotes: [] })));
  await render();
  const first = { ...reference('current', 'draft-first').attachment, text: 'First paragraph.' };
  const second = { ...reference('current', 'draft-second').attachment, text: 'Second paragraph.' };
  await act(async () =>
    useChatStore.getState().setPendingChatInsert({ threadId: 'here', text: '', contextAttachments: [second, first] }),
  );
  expect(
    container.querySelector('[data-pending-file-quote="quote-draft-second"]')?.textContent,
    container.innerHTML,
  ).toBe('1');
  expect(container.querySelector('[data-pending-file-quote="quote-draft-first"]')?.textContent).toBe('2');
  expect(container.textContent).toContain('尚未发送');
  const ownerReads = mocks.fetch.mock.calls.length;
  await act(async () => {
    syncContextAttachmentDraftToStorage('here', [second, first]);
    useChatStore.setState({ pendingChatInsert: null });
  });
  expect(container.querySelectorAll('[data-pending-file-quote]')).toHaveLength(2);
  await act(async () => syncContextAttachmentDraftToStorage('here', [first]));
  expect(container.querySelector('[data-pending-file-quote="quote-draft-first"]')?.textContent).toBe('1');
  expect(container.querySelector('[data-pending-file-quote="quote-draft-second"]')).toBeNull();
  expect(mocks.fetch).toHaveBeenCalledTimes(ownerReads);
  expect(mocks.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('does not guess an unsent position for a different version, duplicate passage, or another thread', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.sourceLine ? new DOMRect(0, 160, 300, 20) : new DOMRect(0, 0, 300, 500);
  });
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ sourceRevision: revision, quotes: [] })));
  const quote = reference('current', 'pending').attachment;
  await act(async () => syncContextAttachmentDraftToStorage('here', [quote]));
  await render(`sha256:${'b'.repeat(64)}`);
  expect(container.querySelector('[data-pending-file-quote]')).toBeNull();
  expect(container.textContent).toContain('无法确认当前位置');
  await render();
  await act(async () =>
    root.render(
      <WorkspaceContentReviewText
        text={'Second paragraph.\n\nSecond paragraph.'}
        revision={revision}
        locator={{ worktreeId: 'work', path: 'guide.md' }}
        markdown
        onQuoteSelected={vi.fn()}
      />,
    ),
  );
  expect(container.querySelector('[data-pending-file-quote]')).toBeNull();
  expect(container.textContent).toContain('无法确认当前位置');
  await act(async () => useChatStore.setState({ currentThreadId: 'other' }));
  expect(container.textContent).not.toContain('尚未发送');
});

it('can explicitly recheck an already loaded message projection and removes withdrawn references', async () => {
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ sourceRevision: revision, quotes: [reference('current')] })),
  );
  await render();
  expect(container.querySelector('[data-file-quote-reference]')).not.toBeNull();
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ sourceRevision: revision, quotes: [] })));
  const reload = [...container.querySelectorAll('button')].find((button) => button.textContent === '重新读取引用消息');
  expect(reload).toBeDefined();
  await act(async () => reload?.click());
  expect(container.querySelector('[data-file-quote-reference]')).toBeNull();
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

it('does not borrow another conversation queue and immediately respects a queued removal', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.sourceLine ? new DOMRect(0, 160, 300, 20) : new DOMRect(0, 0, 300, 500);
  });
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ sourceRevision: revision, quotes: [] })));
  const quote = reference('current', 'own-draft').attachment;
  syncContextAttachmentDraftToStorage('here', [quote]);
  await render();
  await act(async () =>
    useChatStore
      .getState()
      .setPendingChatInsert({ threadId: 'other', text: '', contextAttachments: [{ ...quote, id: 'foreign-draft' }] }),
  );
  expect(container.querySelector('[data-pending-file-quote]')?.getAttribute('data-pending-file-quote')).toBe(quote.id);
  await act(async () =>
    useChatStore
      .getState()
      .setPendingChatInsert({ threadId: 'here', text: '', removeContextAttachmentIds: [quote.id] }),
  );
  expect(container.querySelector('[data-pending-file-quote]')).toBeNull();
  expect(container.textContent).not.toContain('尚未发送');
});

it('focuses the clicked paragraph group by its composite message identity, not the first list row', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.sourceLine
      ? new DOMRect(0, Number(this.dataset.sourceLine) * 40 + 100, 300, 20)
      : this.dataset.testid === 'workspace-content-review-text'
        ? new DOMRect(0, 80, 300, 400)
        : new DOMRect(0, 0, 300, 500);
  });
  const unrelated = { ...reference('current', 'unrelated'), anchor: { start: 0, end: 16, quote: 'First paragraph.' } };
  const groupFirst = reference('current', 'group-first');
  // Duplicate attachment ids are valid in different messages; focus must use the composite source key.
  const first = { ...groupFirst, attachment: { ...groupFirst.attachment, id: unrelated.attachment.id } };
  const second = reference('current', 'group-second');
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ sourceRevision: revision, quotes: [unrelated, first, second] })),
  );
  await render();
  const groups = [...container.querySelectorAll<HTMLButtonElement>('[data-file-quote-mark]')];
  const group = groups.find((button) => button.getAttribute('aria-label') === '查看这一处的 2 条引用');
  expect(group).toBeDefined();
  await act(async () => group?.click());
  const expected = [...container.querySelectorAll<HTMLButtonElement>('[data-file-quote-reference]')][1];
  expect(document.activeElement).toBe(expected);
  expect(mocks.open).not.toHaveBeenCalled();
});

it('prepends older pages in chronological order including timestamp/id ties', async () => {
  const older = [
    { ...reference('current', 'm1'), timestamp: 5 },
    { ...reference('current', 'm2'), timestamp: 10 },
  ];
  const recent = [
    { ...reference('current', 'm3'), timestamp: 10 },
    { ...reference('current', 'm4'), timestamp: 11 },
  ];
  mocks.fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ sourceRevision: revision, quotes: recent, nextCursor: '10:m3' })),
  );
  await render();
  mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ sourceRevision: revision, quotes: older })));
  const list = container.querySelector('details');
  expect(list).not.toBeNull();
  if (list) list.open = true;
  const more = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === '读取更多消息',
  );
  await act(async () => more?.click());
  expect(mocks.fetch.mock.calls.at(-1)?.[0]).toContain('before=10%3Am3');
  expect(
    [...container.querySelectorAll('[data-file-quote-reference]')].map((button) =>
      button.getAttribute('data-file-quote-reference'),
    ),
  ).toEqual(['quote-m1', 'quote-m2', 'quote-m3', 'quote-m4']);
});
