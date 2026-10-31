import type { WorkspaceFileQuoteReference } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceContentReviewText } from '../content-review/WorkspaceContentReviewText';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', async (original) => ({
  ...(await original<typeof import('@/utils/api-client')>()),
  apiFetch: (...args: unknown[]) => mocks.fetch(...args),
}));
vi.mock('@/components/workspace/useWorkspaceListenMode', () => ({
  useWorkspaceListenMode: () => ({ active: false, sentences: [], hasSentences: false }),
}));
vi.mock('@/components/workspace/WorkspaceListenActions', () => ({ WorkspaceListenActions: () => null }));
const revision: `sha256:${string}` = `sha256:${'a'.repeat(64)}`;
const attachment = {
  v: 1 as const,
  id: 'draft',
  kind: 'quote' as const,
  text: 'Second paragraph.',
  source: { kind: 'workspace_file' as const, worktreeId: 'work', path: 'guide.md', revision },
};
const reference: WorkspaceFileQuoteReference = {
  messageId: 'source',
  threadId: 'here',
  authorCatId: 'codex-astra',
  timestamp: 1,
  quoteNumber: 1,
  state: 'current',
  attachment: { ...attachment, id: 'published' },
  anchor: { start: 18, end: 35, quote: 'Second paragraph.' },
};
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // A details toggle changes positions even when neither observed box changes size.
  vi.stubGlobal('ResizeObserver', undefined);
  localStorage.clear();
  syncContextAttachmentDraftToStorage('here', []);
  useChatStore.setState({ currentThreadId: 'here', messages: [], pendingChatInsert: null });
  mocks.fetch.mockReset();
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ sourceRevision: revision, quotes: [reference] })));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const shift = container.querySelector('details')?.open ? 200 : 0;
    return this.dataset.sourceLine
      ? new DOMRect(0, 120 + shift, 300, 20)
      : this.dataset.testid === 'workspace-content-review-text'
        ? new DOMRect(0, 40 + shift, 300, 400)
        : new DOMRect(0, 0, 300, 500);
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

for (const pending of [false, true])
  it(`keeps ${pending ? 'composer' : 'published'} marks beside their paragraph across details expansion without a resize`, async () => {
    if (pending)
      useChatStore.setState({ pendingChatInsert: { threadId: 'here', text: '', contextAttachments: [attachment] } });
    await act(async () =>
      root.render(
        <WorkspaceContentReviewText
          text={'First paragraph.\n\nSecond paragraph.'}
          revision={revision}
          locator={{ worktreeId: 'work', path: 'guide.md' }}
          markdown
          onQuoteSelected={vi.fn()}
        />,
      ),
    );
    const mark = container.querySelector<HTMLElement>(pending ? '[data-pending-file-quote]' : '[data-file-quote-mark]');
    expect(mark?.style.top).toBe('120px');
    await act(async () => container.querySelector('summary')?.click());
    expect(container.querySelector('details')?.open).toBe(true);
    expect(mark?.style.top).toBe('320px');
    await act(async () => container.querySelector('summary')?.click());
    expect(mark?.style.top).toBe('120px');
  });
