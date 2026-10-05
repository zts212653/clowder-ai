import type { WorkspaceContentReviewView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceContentReviewSurface } from '../WorkspaceContentReviewSurface';
import { view } from './WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div data-testid="rendered-markdown">{content}</div>,
}));

/** A text landing view for any path; the owner read is otherwise the shared fixture. */
function textView(path: string, annotation = false): WorkspaceContentReviewView {
  const base = view(annotation);
  if (base.review.source.kind !== 'text') throw new Error('fixture must be a text source');
  const source = { ...base.review.source, locator: { ...base.review.source.locator, path } };
  return { ...base, review: { ...base.review, source }, ...(base.currentSource ? { currentSource: source } : {}) };
}

function selectText(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const rect = () => new DOMRect(40, 60, 120, 18);
  Object.defineProperties(range, {
    getClientRects: { value: () => [rect()] },
    getBoundingClientRect: { value: rect },
  });
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    anchorNode: node,
    focusNode: node,
    toString: () => range.toString(),
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
  document.dispatchEvent(new Event('selectionchange'));
}

function typeComment(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function textNodeContaining(root: Element, needle: string): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(needle)) return node as Text;
  }
  throw new Error(`no text node contains ${needle}`);
}

describe('F309 text landing: a selection goes through the one existing chat quote chain', () => {
  let container: HTMLDivElement;
  let root: Root;
  const initial = useChatStore.getState();

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    useChatStore.setState({ currentThreadId: 'thread-a', pendingChatInsert: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState(initial, true);
    vi.restoreAllMocks();
  });

  async function render(current: WorkspaceContentReviewView, sourceText: string) {
    if (current.review.source.kind !== 'text') throw new Error('text only');
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/workspace/content-reviews/prepare' || url.endsWith(current.review.reviewId))
        return new Response(JSON.stringify(current));
      throw new Error(`unexpected route: ${url}`);
    });
    await act(async () => {
      root.render(
        <WorkspaceContentReviewSurface
          worktreeId="worktree-a"
          path={current.review.source.kind === 'text' ? current.review.source.locator.path : ''}
          sourceText={sourceText}
          sourceTextRevision={current.review.source.revision}
          onBack={vi.fn()}
        />,
      );
    });
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
  }

  async function annotate(node: Node, start: number, end: number, comment: string) {
    // jsdom has no layout: give the text surface the box a browser would, so the card has a place to open.
    const surface = container.querySelector<HTMLElement>('[data-testid="workspace-content-review-text"]');
    if (surface) surface.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    await act(async () => selectText(node, start, end));
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-content-review-text-add-to-chat"]',
    );
    expect(trigger, 'a selection offers the original in-place card').not.toBeNull();
    await act(async () => trigger?.click());
    const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    expect(editor).not.toBeNull();
    await act(async () => editor && typeComment(editor, comment));
    await act(async () =>
      editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
  }

  it('Enter puts a workspace_file quote chip into the current chat input and writes nothing else', async () => {
    const sourceText = 'Intro line.\nA unique source quote.\n';
    await render(textView('notes.md'), sourceText);
    const node = textNodeContaining(container.querySelector('[data-testid="rendered-markdown"]')!, 'unique');
    const start = node.textContent!.indexOf('A unique');
    await annotate(node, start, start + 'A unique source quote.'.length, '这里要改 · clarify\nsecond line');

    const insert = useChatStore.getState().pendingChatInsert;
    expect(insert).toMatchObject({ threadId: 'thread-a', text: '' });
    expect(insert?.contextAttachments).toEqual([
      expect.objectContaining({
        kind: 'quote',
        text: 'A unique source quote.',
        comment: '这里要改 · clarify\nsecond line',
        source: expect.objectContaining({ kind: 'workspace_file', path: 'notes.md', worktreeId: 'worktree-a' }),
      }),
    ]);
    // Adding is not sending, not delegating and not a second F309 text annotation.
    const posts = mocks.apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(posts.map(([url]) => url)).toEqual(['/api/workspace/content-reviews/prepare']);
  });

  it('no longer offers the separate bottom composer for new text annotations', async () => {
    await render(textView('notes.md'), 'A unique source quote.');
    expect(container.textContent).not.toContain('已选文本');
    expect(container.querySelector('textarea[placeholder="写下这条批注…"]')).toBeNull();
    expect(container.querySelector('button[aria-label="保存批注"]')).toBeNull();
  });

  it('a code selection carries the real line range of the file', async () => {
    const sourceText = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    await render(textView('src/a.ts'), sourceText);
    const node = textNodeContaining(container.querySelector('[data-testid="workspace-content-review-text"]')!, 'b = 2');
    await annotate(node, 0, 'const b = 2;'.length, 'why two?');
    expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
      kind: 'quote',
      text: 'const b = 2;',
      source: { kind: 'workspace_file', path: 'src/a.ts', worktreeId: 'worktree-a', lineStart: 2, lineEnd: 2 },
    });
  });

  it('Enter while an IME is composing does not add the chip', async () => {
    const sourceText = 'Intro line.\nA unique source quote.\n';
    await render(textView('notes.md'), sourceText);
    const surface = container.querySelector<HTMLElement>('[data-testid="workspace-content-review-text"]');
    if (surface) surface.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    const node = textNodeContaining(container.querySelector('[data-testid="rendered-markdown"]')!, 'unique');
    const start = node.textContent!.indexOf('A unique');
    await act(async () => selectText(node, start, start + 8));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-content-review-text-add-to-chat"]')?.click(),
    );
    const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    if (!editor) throw new Error('card editor is missing');
    await act(async () => typeComment(editor, '拼音'));
    await act(async () => editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await act(async () =>
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    await act(async () => editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    // Chrome delivers the candidate-confirming Enter right after compositionend: still not a save.
    await act(async () =>
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
    await act(async () =>
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({ comment: '拼音' });
  });

  it('an existing text discussion stays and is replied to under its original id', async () => {
    const current = textView('notes.md', true);
    const annotationId = current.review.annotations[0]!.id;
    await render(current, 'Intro line.\nA unique source quote.\n');
    expect(container.textContent).toContain('Please clarify this sentence.');
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/actions')) return new Response(JSON.stringify({}));
      if (url.endsWith(current.review.reviewId)) return new Response(JSON.stringify(current));
      throw new Error(`unexpected route: ${url}`);
    });
    const reply = container.querySelector<HTMLTextAreaElement>(`[aria-label="回复批注 ${annotationId}"]`);
    if (!reply) throw new Error('the old text discussion lost its reply input');
    await act(async () => typeComment(reply, '已按这句改好'));
    const send = [...container.querySelectorAll('button')].find((button) => button.textContent === '回复');
    await act(async () => send?.click());
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
    const posts = mocks.apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(posts.map(([url]) => url)).toEqual([
      '/api/workspace/content-reviews/prepare',
      `/api/workspace/content-reviews/${current.review.reviewId}/actions`,
    ]);
    expect(JSON.parse(String((posts[1]?.[1] as RequestInit).body))).toMatchObject({
      action: { kind: 'reply', annotationId, body: '已按这句改好' },
    });
  });
});
