import type { WorkspaceContentReviewView } from '@cat-cafe/shared';
import { EditorView } from '@codemirror/view';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { composerAttachments } from '@/components/composer-queue';
import { addWorkspaceFileQuoteToChat, workspaceFileQuoteAttachment } from '@/components/workspace/workspace-file-quote';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceChatRevealProvider } from '../../WorkspaceChatReveal';
import { WorkspaceSurfaceVisibilityProvider } from '../../WorkspaceSurfaceVisibility';
import { WorkspaceContentReviewSurface } from '../WorkspaceContentReviewSurface';
import { view } from './WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => (
    <div data-testid="rendered-markdown" data-source-line="1">
      {content}
    </div>
  ),
}));

vi.mock('@/components/content-review/TextMessageRequestStatus', () => ({
  TextMessageRequestStatus: ({ message }: { message: { id: string } }) => <output>{message.id}</output>,
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
  const revealChat = vi.fn();
  const initial = useChatStore.getState();

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
  const rangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect');
  beforeEach(() => {
    // CodeMirror measures real ranges; jsdom provides no layout APIs for them.
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => new DOMRect(0, 0, 800, 20),
    });
    mocks.apiFetch.mockReset();
    revealChat.mockReset();
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
    if (rangeRects) Object.defineProperty(Range.prototype, 'getClientRects', rangeRects);
    else Reflect.deleteProperty(Range.prototype, 'getClientRects');
    if (rangeBounds) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeBounds);
    else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  });

  async function render(current: WorkspaceContentReviewView, sourceText: string, visible = true) {
    if (current.review.source.kind !== 'text') throw new Error('text only');
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/workspace/content-reviews/prepare' || url.endsWith(current.review.reviewId))
        return new Response(JSON.stringify(current));
      throw new Error(`unexpected route: ${url}`);
    });
    await act(async () => {
      root.render(
        <WorkspaceChatRevealProvider threadId="thread-a" onReveal={revealChat}>
          <WorkspaceSurfaceVisibilityProvider visible={visible}>
            <WorkspaceContentReviewSurface
              worktreeId="worktree-a"
              path={current.review.source.kind === 'text' ? current.review.source.locator.path : ''}
              sourceText={sourceText}
              sourceTextRevision={current.review.source.revision}
              onBack={vi.fn()}
            />
          </WorkspaceSurfaceVisibilityProvider>
        </WorkspaceChatRevealProvider>,
      );
    });
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
  }

  async function annotate(node: Node, start: number, end: number, comment: string) {
    // jsdom has no layout: give the text surface the box a browser would, so the card has a place to open.
    const surface = container.querySelector<HTMLElement>('[data-testid="workspace-content-review-text"]');
    if (surface) surface.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
    await act(async () => {
      selectText(node, start, end);
      surface?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
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

  it('请猫修改 uses the two queued file places in the same composer and never opens a request form', async () => {
    const current = textView('notes.md');
    if (current.review.source.kind !== 'text') throw new Error('text only');
    useChatStore.setState({ pendingChatInsert: { threadId: 'thread-a', text: '原有草稿\nsecond line' } });
    for (const text of ['Intro line.', 'A unique source quote.']) {
      addWorkspaceFileQuoteToChat('thread-a', {
        text,
        comment: '保留这条批注',
        path: 'notes.md',
        worktreeId: current.review.source.locator.worktreeId,
        revision: current.review.source.revision,
      });
    }
    const before = composerAttachments('thread-a');
    await render(current, 'Intro line.\nA unique source quote.\n');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="content-modification-entry"]')!.click(),
    );
    expect(mocks.apiFetch.mock.calls.some(([url]) => url === '/api/content-modifications/context')).toBe(false);
    expect(composerAttachments('thread-a')).toEqual(before);
    expect(useChatStore.getState().pendingChatInsert?.text).toBe('原有草稿\nsecond line');
    expect(container.querySelector('[data-testid="content-modification-panel"]')).toBeNull();
    expect(revealChat).toHaveBeenCalledTimes(1);
  });

  it('a saved annotation consumes its live selection before 请猫修改 uses the queued places', async () => {
    const current = textView('notes.md');
    if (current.review.source.kind !== 'text') throw new Error('text only');
    const text = 'A unique source quote.';
    await render(current, text);
    const node = textNodeContaining(container.querySelector('[data-testid="rendered-markdown"]')!, text);
    await annotate(node, 0, text.length, 'original comment');
    const before = useChatStore.getState().pendingChatInsert;
    expect(before?.contextAttachments).toHaveLength(1);
    const beforeCalls = mocks.apiFetch.mock.calls.length;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="content-modification-entry"]')!.click(),
    );
    expect(mocks.apiFetch.mock.calls.slice(beforeCalls).filter(([, init]) => init?.method === 'POST')).toEqual([]);
    expect(useChatStore.getState().pendingChatInsert).toBe(before);
  });

  it('请猫修改 adds an explicitly selected place at the verified file revision without sending', async () => {
    const current = textView('notes.md');
    if (current.review.source.kind !== 'text') throw new Error('text only');
    const text = 'Intro line.\nA unique source quote.\n';
    await render(current, text);
    const quote = 'A unique source quote.';
    const start = text.indexOf(quote);
    const node = textNodeContaining(container.querySelector('[data-testid="rendered-markdown"]')!, quote);
    await act(async () => {
      selectText(node, start, start + quote.length);
      container
        .querySelector('[data-testid="workspace-content-review-text"]')!
        .dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/content-modifications/selection')
        return new Response(
          JSON.stringify({
            selection: {
              kind: 'text_quote',
              baseRevision: current.review.source.revision,
              start,
              end: start + quote.length,
              quote,
              quoteDigest: `sha256:${'b'.repeat(64)}`,
              contextDigest: `sha256:${'c'.repeat(64)}`,
            },
          }),
        );
      throw new Error(`unexpected route: ${url}`);
    });
    const beforeCalls = mocks.apiFetch.mock.calls.length;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="content-modification-entry"]')!.click(),
    );
    expect(composerAttachments('thread-a')).toEqual([
      expect.objectContaining({
        kind: 'quote',
        text: quote,
        selectionStart: start,
        selectionEnd: start + quote.length,
        source: expect.objectContaining({
          kind: 'workspace_file',
          path: 'notes.md',
          revision: current.review.source.revision,
        }),
      }),
    ]);
    expect(
      mocks.apiFetch.mock.calls
        .slice(beforeCalls)
        .filter(([, init]) => init?.method === 'POST')
        .map(([url]) => url),
    ).toEqual(['/api/content-modifications/selection']);
    expect(revealChat).toHaveBeenCalledTimes(1);
  });

  it('an empty 请猫修改 explains choosing places and opens no form', async () => {
    await render(textView('notes.md'), 'A unique source quote.');
    const beforeCalls = mocks.apiFetch.mock.calls.length;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="content-modification-entry"]')!.click(),
    );
    expect(container.textContent).toContain('在文档里选一处或几处');
    expect(mocks.apiFetch.mock.calls.slice(beforeCalls)).toEqual([]);
    expect(composerAttachments('thread-a')).toEqual([]);
    expect(revealChat).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="content-modification-panel"]')).toBeNull();
  });

  it('a late 请猫修改 selection answer cannot add a quote to another conversation', async () => {
    const current = textView('notes.md');
    const text = 'A unique source quote.';
    await render(current, text);
    const node = textNodeContaining(container.querySelector('[data-testid="rendered-markdown"]')!, text);
    await act(async () => {
      selectText(node, 0, text.length);
      container
        .querySelector('[data-testid="workspace-content-review-text"]')!
        .dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    let finish!: (response: Response) => void;
    mocks.apiFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="content-modification-entry"]')!.click(),
    );
    await act(async () => useChatStore.setState({ currentThreadId: 'thread-b' }));
    await act(async () =>
      finish(
        new Response(
          JSON.stringify({
            selection: {
              kind: 'text_quote',
              baseRevision: current.review.source.revision,
              start: 0,
              end: text.length,
              quote: text,
              quoteDigest: `sha256:${'b'.repeat(64)}`,
              contextDigest: `sha256:${'c'.repeat(64)}`,
            },
          }),
        ),
      ),
    );
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    expect(revealChat).not.toHaveBeenCalled();
  });

  it('the document header uses the same exact sent Human quote rather than another file or mixed scope', async () => {
    const current = textView('notes.md');
    const message = (id: string, path: string, revision: string) => ({
      id,
      type: 'user' as const,
      content: '请改这处',
      timestamp: 1,
      contentBlocks: [
        {
          type: 'context_attachment' as const,
          attachment: workspaceFileQuoteAttachment({
            text: 'A unique source quote.',
            comment: '',
            path,
            revision,
            worktreeId: 'worktree-a',
          }),
        },
      ],
    });
    const exact = message('human-exact', 'notes.md', current.review.source.revision);
    const other = message('human-other', 'other.md', current.review.source.revision);
    useChatStore.setState({
      messages: [
        message('human-old', 'notes.md', `sha256:${'e'.repeat(64)}`),
        exact,
        other,
        {
          ...message('human-mixed', 'notes.md', current.review.source.revision),
          contentBlocks: [...exact.contentBlocks, ...other.contentBlocks],
        },
      ],
    });
    await render(current, 'A unique source quote.');
    expect(container.querySelector('[data-testid="text-work-progress"]')?.textContent).toBe('human-exact');
  });

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

  it('opens a pending file number to edit and remove the same quote without losing the queued draft', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    const sourceText = 'A unique source quote.';
    await render(textView('notes.md'), sourceText);
    const node = textNodeContaining(container.querySelector('[data-testid="rendered-markdown"]')!, sourceText);
    await annotate(node, 0, sourceText.length, '原说明');
    const original = composerAttachments('thread-a')[0]!;
    await act(async () => {
      const queued = useChatStore.getState().pendingChatInsert!;
      useChatStore.getState().setPendingChatInsert({ ...queued, text: '原有草稿\nsecond line' });
    });
    const mark = container.querySelector<HTMLButtonElement>('[data-pending-file-quote]');
    expect(mark?.tagName, 'the visible file number must offer the same editable annotation card').toBe('BUTTON');
    await act(async () => mark?.click());
    const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    expect(editor?.value).toBe('原说明');
    await act(async () => editor && typeComment(editor, '改后的说明 · mixed\nnext line'));
    await act(async () =>
      editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    expect(composerAttachments('thread-a')).toEqual([{ ...original, comment: '改后的说明 · mixed\nnext line' }]);
    expect(useChatStore.getState().pendingChatInsert?.text).toBe('原有草稿\nsecond line');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-pending-file-quote]')?.click());
    const remove = document.querySelector<HTMLButtonElement>('button[aria-label="删除批注"]');
    expect(remove).not.toBeNull();
    await act(async () => remove?.click());
    expect(composerAttachments('thread-a')).toEqual([]);
    expect(useChatStore.getState().pendingChatInsert?.text).toBe('原有草稿\nsecond line');
    const posts = mocks.apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(posts.map(([url]) => url)).toEqual(['/api/workspace/content-reviews/prepare']);
  });

  it('lets the person choose the second pending quote in one paragraph and leaves the first unchanged', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    const sourceText = 'Alpha is one quote. Beta is another quote.';
    await render(textView('notes.md'), sourceText);
    const node = textNodeContaining(container.querySelector('[data-testid="rendered-markdown"]')!, 'Alpha');
    await annotate(node, 0, 'Alpha is one quote.'.length, 'first comment');
    const start = sourceText.indexOf('Beta');
    await annotate(node, start, sourceText.length, 'second comment');
    const before = composerAttachments('thread-a');
    expect(before).toHaveLength(2);
    const mark = container.querySelector<HTMLButtonElement>('[data-pending-file-quote]');
    expect(mark?.tagName).toBe('BUTTON');
    await act(async () => mark?.click());
    expect(document.querySelector('[data-testid="context-annotation-comment"]')).toBeNull();
    let second = document.querySelector<HTMLButtonElement>('button[aria-label="编辑第 2 处批注"]');
    expect(second).not.toBeNull();
    const closeWorkspace = vi.fn();
    const hostEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) closeWorkspace();
    };
    window.addEventListener('keydown', hostEscape);
    try {
      await act(async () =>
        second?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
      );
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(mark);
      expect(composerAttachments('thread-a')).toEqual(before);
      expect(closeWorkspace).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', hostEscape);
    }
    await act(async () => mark?.click());
    second = document.querySelector<HTMLButtonElement>('button[aria-label="编辑第 2 处批注"]');
    await act(async () => second?.click());
    const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    expect(editor?.value).toBe('second comment');
    await act(async () => editor && typeComment(editor, 'only the second changed'));
    await act(async () =>
      editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    expect(composerAttachments('thread-a')).toEqual([before[0], { ...before[1], comment: 'only the second changed' }]);
  });

  it('closes an editor when the file is hidden and does not reopen it on return', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    const current = textView('notes.md');
    const text = 'A unique source quote.';
    await render(current, text);
    const node = textNodeContaining(container.querySelector('[data-testid="rendered-markdown"]')!, text);
    await annotate(node, 0, text.length, 'kept comment');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-pending-file-quote]')?.click());
    expect(document.querySelector('[data-testid="context-annotation-comment"]')).not.toBeNull();
    await render(current, text, false);
    expect(document.querySelector('[data-testid="context-annotation-comment"]')).toBeNull();
    await render(current, text);
    expect(document.querySelector('[data-testid="context-annotation-comment"]')).toBeNull();
    expect(composerAttachments('thread-a')[0]).toMatchObject({ text, comment: 'kept comment' });
  });

  it('uses one toolbar for the document and leaves native body context selection untouched', async () => {
    await render(textView('notes.md'), 'Intro line.\nA unique source quote.\n');
    expect(container.querySelectorAll('[data-testid="content-file-toolbar"]')).toHaveLength(1);
    const body = container.querySelector('[data-testid="rendered-markdown"]')!;
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    body.dispatchEvent(context);
    expect(context.defaultPrevented).toBe(false);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    const name = container.querySelector('[data-testid="content-file-toolbar"] [title="notes.md"]')!;
    await act(async () => name.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(container.querySelectorAll('[role="menu"]')).toHaveLength(1);
  });

  it('a code selection carries the real line range of the file', async () => {
    const sourceText = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    await render(textView('src/a.ts'), sourceText);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const cm = container.querySelector<HTMLElement>('.cm-editor');
    expect(cm).not.toBeNull();
    const editor = EditorView.findFromDOM(cm!);
    expect(editor).not.toBeNull();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    vi.spyOn(editor!, 'coordsAtPos').mockReturnValue({ left: 10, right: 100, top: 20, bottom: 40 });
    vi.spyOn(editor!, 'posAtCoords').mockReturnValue(13);
    await act(async () => editor!.dispatch({ selection: { anchor: 13, head: 25 } }));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="workspace-code-selection-add-to-chat"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());
    const comment = document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]')!;
    await act(async () => typeComment(comment, 'why two?'));
    await act(async () =>
      comment.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
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
