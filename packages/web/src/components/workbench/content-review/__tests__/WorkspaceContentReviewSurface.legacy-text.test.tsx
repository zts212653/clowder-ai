import type { WorkspaceContentReviewView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { WorkspaceContentReviewSurface } from '../WorkspaceContentReviewSurface';
import { reviewId, revision, view } from './WorkspaceContentReviewSurface.fixture';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div data-testid="rendered-markdown">{content}</div>,
}));

const oldRevision = `sha256:${'e'.repeat(64)}`;
const keyOf = (sourceRevision: string) => `cat-cafe:content-review:operator:${reviewId}:version:${sourceRevision}`;
const quote = 'A unique source quote.';
const sourceText = `Intro line.\n${quote}\n`;
type Stored = {
  body?: string;
  target?: { kind: 'text_quote'; quote: string } | null;
  annotation?: {
    operationId: string;
    expectedRevision: number;
    body: string;
    target: { kind: 'text_quote'; quote: string };
  } | null;
};
function store(sourceRevision: string, draft: Stored) {
  localStorage.setItem(
    keyOf(sourceRevision),
    JSON.stringify({
      v: 1,
      body: '',
      target: null,
      activeAnnotationId: null,
      annotation: null,
      action: null,
      refresh: null,
      ...draft,
    }),
  );
}
const stored = (sourceRevision: string) => JSON.parse(localStorage.getItem(keyOf(sourceRevision)) ?? 'null');
const pendingOld = (operationId: string, expectedRevision: number) => ({
  operationId,
  expectedRevision,
  body: '旧批注：这句要改\nsecond line',
  target: { kind: 'text_quote' as const, quote },
});

describe('F309 text landing: old text annotations are finished, never written again', () => {
  let container: HTMLDivElement;
  let root: Root;
  const initial = useChatStore.getState();

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    localStorage.clear();
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
    localStorage.clear();
    vi.restoreAllMocks();
  });

  async function render(current: WorkspaceContentReviewView, receipt: unknown = { receipt: null }) {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/workspace/content-reviews/prepare' || url === `/api/workspace/content-reviews/${reviewId}`)
        return new Response(JSON.stringify(current));
      if (url.startsWith(`/api/workspace/content-reviews/${reviewId}/operations/`))
        return new Response(JSON.stringify(receipt));
      throw new Error(`unexpected route: ${url}`);
    });
    await act(async () => {
      root.render(
        <WorkspaceContentReviewSurface
          worktreeId="worktree-a"
          path="notes.md"
          sourceText={sourceText}
          sourceTextRevision={revision}
          onBack={vi.fn()}
        />,
      );
    });
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
  }
  const writes = () =>
    mocks.apiFetch.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      .map(([url]) => url);
  const notes = () => [...container.querySelectorAll('[data-testid="workspace-legacy-text-note"]')];
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);

  async function continueIntoCard(extra: string) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-legacy-text-continue"]')?.click(),
    );
    const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    expect(editor, 'the old draft opens in the original selection card').not.toBeNull();
    const text = `${editor?.value ?? ''}${extra}`;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor, text);
    await act(async () => editor?.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () =>
      editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
  }

  it('an old unsubmitted draft is kept and continues into the card, then the chat chip', async () => {
    store(revision, { body: '旧草稿正文', target: { kind: 'text_quote', quote } });
    await render(view());
    expect(notes()).toHaveLength(1);
    expect(notes()[0]?.textContent).toContain('旧草稿正文');
    expect(notes()[0]?.textContent).toContain(quote);
    expect(notes()[0]?.textContent).not.toContain('旧版本');

    await continueIntoCard(' · 补一句');
    expect(useChatStore.getState().pendingChatInsert?.contextAttachments).toEqual([
      expect.objectContaining({
        kind: 'quote',
        text: quote,
        comment: '旧草稿正文 · 补一句',
        source: expect.objectContaining({ kind: 'workspace_file', path: 'notes.md', worktreeId: 'worktree-a' }),
      }),
    ]);
    expect(stored(revision)).toMatchObject({ body: '', target: null });
    expect(notes()).toHaveLength(0);
    expect(writes()).toEqual(['/api/workspace/content-reviews/prepare']);
  });

  it('a draft written on an earlier file version is shown with its drift, not lost', async () => {
    store(oldRevision, { body: '写在旧版本上的草稿', target: { kind: 'text_quote', quote: 'Gone sentence.' } });
    await render(view());
    expect(notes()).toHaveLength(1);
    expect(notes()[0]?.textContent).toContain('写于文件的旧版本');
    await continueIntoCard('');
    expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
      text: 'Gone sentence.',
      comment: '写在旧版本上的草稿',
    });
    expect(stored(oldRevision)).toMatchObject({ body: '', target: null });
    expect(writes()).toEqual(['/api/workspace/content-reviews/prepare']);
  });

  it('an unknown old save that the review shows is settled as saved without asking to retry', async () => {
    const operationId = 'op-landed';
    store(revision, {
      body: pendingOld(operationId, 1).body,
      target: { kind: 'text_quote', quote },
      annotation: pendingOld(operationId, 1),
    });
    const landed = view(true);
    landed.review.annotations = landed.review.annotations.map((annotation) => ({ ...annotation, operationId }));
    await render(landed);
    expect(notes()).toHaveLength(0);
    expect(container.textContent).not.toContain('核对并重试保存');
    expect(stored(revision)).toMatchObject({ annotation: null, body: '' });
    expect(writes()).toEqual(['/api/workspace/content-reviews/prepare']);
  });

  it('a provably unsaved old save (no receipt, review moved past it) becomes a continuable draft', async () => {
    store(revision, {
      annotation: pendingOld('op-lost', 1),
      body: pendingOld('op-lost', 1).body,
      target: { kind: 'text_quote', quote },
    });
    await render(view(true));
    expect(container.textContent).not.toContain('核对并重试保存');
    expect(notes()[0]?.textContent).toContain('保存结果还没确认');
    await act(async () => button('核对保存结果')?.click());
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
    expect(container.textContent).toContain('已确认这条批注没有保存');
    expect(stored(revision)).toMatchObject({ annotation: null, body: pendingOld('op-lost', 1).body });
    expect(container.querySelector('[data-testid="workspace-legacy-text-continue"]')).not.toBeNull();
    expect(writes()).toEqual(['/api/workspace/content-reviews/prepare']);
  });

  it('without the revision fence the result stays unknown and nothing is re-sent', async () => {
    store(revision, { annotation: pendingOld('op-maybe', 1) });
    await render(view());
    await act(async () => button('核对保存结果')?.click());
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
    expect(container.textContent).toContain('保存结果仍无法确认');
    expect(stored(revision)).toMatchObject({ annotation: { operationId: 'op-maybe' } });
    expect(container.querySelector('[data-testid="workspace-legacy-text-continue"]')).toBeNull();
    expect(writes()).toEqual(['/api/workspace/content-reviews/prepare']);
  });

  it('an old save on an earlier version confirmed by its owner receipt is settled there', async () => {
    store(oldRevision, { annotation: pendingOld('op-receipt', 1) });
    await render(view(true), {
      receipt: {
        receiptRef: 'receipt-1',
        reviewId,
        operationId: 'op-receipt',
        revision: 2,
        actor: { kind: 'human', actorId: 'operator' },
        createdAt: '2026-09-16T00:00:00.000Z',
        replayed: false,
      },
    });
    await act(async () => button('核对保存结果')?.click());
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
    expect(container.textContent).toContain('当时已经保存');
    expect(stored(oldRevision)).toMatchObject({ annotation: null });
    expect(notes()).toHaveLength(0);
    expect(writes()).toEqual(['/api/workspace/content-reviews/prepare']);
  });

  it('selecting text for "请猫修改" never overwrites the quote of an old draft', async () => {
    store(revision, { body: '旧草稿正文', target: { kind: 'text_quote', quote } });
    await render(view());
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'Intro line.' } as Selection);
    const text = container.querySelector<HTMLElement>('[data-testid="workspace-content-review-text"]');
    await act(async () => text?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    expect(stored(revision)).toMatchObject({ body: '旧草稿正文', target: { kind: 'text_quote', quote } });
  });

  // Sol #4747 review P1: the old client let a person keep typing while a save was unconfirmed, so one stored
  // draft holds two independent texts. Neither may be hidden, and neither may be lost by settling the other.
  describe('an unconfirmed old save with newer text typed after it', () => {
    const later = { body: '后来又写的一句', target: { kind: 'text_quote' as const, quote: 'Intro line.' } };
    const kinds = () => notes().map((note) => note.getAttribute('data-legacy-kind'));
    const flush = async () => {
      for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
    };

    it('shows both while unknown, and re-sends neither', async () => {
      store(revision, { ...later, annotation: pendingOld('op-old', 1) });
      await render(view());
      expect(kinds()).toEqual(['pending', 'draft']);
      await act(async () => button('核对保存结果')?.click());
      await flush();
      expect(container.textContent).toContain('保存结果仍无法确认');
      expect(kinds()).toEqual(['pending', 'draft']);
      expect(writes()).toEqual(['/api/workspace/content-reviews/prepare']);
    });

    it('saved settles only the old save; the newer text stays its own draft', async () => {
      const landed = view(true);
      store(revision, { ...later, annotation: pendingOld('op-old', 1) });
      await render(landed, {
        receipt: {
          receiptRef: 'r',
          reviewId,
          operationId: 'op-old',
          revision: 2,
          actor: { kind: 'human', actorId: 'operator' },
          createdAt: '2026-09-16T00:00:00.000Z',
          replayed: false,
        },
      });
      await act(async () => button('核对保存结果')?.click());
      await flush();
      expect(container.textContent).toContain('当时已经保存');
      expect(stored(revision)).toMatchObject({ annotation: null, ...later });
      expect(kinds()).toEqual(['draft']);
    });

    it('unsaved keeps the old text continuable without overwriting the newer draft', async () => {
      store(revision, { ...later, annotation: pendingOld('op-old', 1) });
      await render(view(true));
      await act(async () => button('核对保存结果')?.click());
      await flush();
      expect(container.textContent).toContain('已确认这条批注没有保存');
      expect(stored(revision)).toMatchObject({ annotation: null, ...later });
      expect(kinds().sort()).toEqual(['draft', 'draft']);
      expect(container.textContent).toContain(pendingOld('op-old', 1).body.split('\n')[0]);
      expect(container.textContent).toContain(later.body);
      expect(writes()).toEqual(['/api/workspace/content-reviews/prepare']);
    });
  });

  // Sol #4747 review P1 (both rounds): a result arriving after two awaits settles only the item it was asked
  // about — on an earlier version's key and on the current version's key, whose stored value another tab or a
  // rolled-back client may have rewritten while this tab still holds the old one in memory.
  const keys = [
    ['an earlier version', oldRevision],
    ['the current version', revision],
  ] as const;

  async function renderWithDeferredReceipt(current: WorkspaceContentReviewView) {
    let answerReceipt: (value: Response) => void = () => undefined;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/workspace/content-reviews/prepare' || url === `/api/workspace/content-reviews/${reviewId}`)
        return new Response(JSON.stringify(current));
      if (url.includes('/operations/')) return new Promise<Response>((resolve) => (answerReceipt = resolve));
      throw new Error(`unexpected route: ${url}`);
    });
    await act(async () => {
      root.render(
        <WorkspaceContentReviewSurface
          worktreeId="worktree-a"
          path="notes.md"
          sourceText={sourceText}
          sourceTextRevision={revision}
          onBack={vi.fn()}
        />,
      );
    });
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
    return (response: Response) => answerReceipt(response);
  }

  it.each(
    keys,
  )('on %s, an old outcome never clears a different save that replaced it while the owner was being asked', async (_name, sourceRevision) => {
    store(sourceRevision, { annotation: pendingOld('op-old', 1) });
    const answer = await renderWithDeferredReceipt(view(true));
    await act(async () => button('核对保存结果')?.click());
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
    store(sourceRevision, { annotation: { ...pendingOld('op-new', 3), body: '另一个标签页的新保存' } });
    await act(async () => answer(new Response(JSON.stringify({ receipt: null }))));
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
    expect(container.textContent).toContain('被别处改动过');
    expect(stored(sourceRevision)).toMatchObject({
      annotation: { operationId: 'op-new', body: '另一个标签页的新保存' },
    });
    expect(localStorage.getItem(`${keyOf(sourceRevision)}#unsaved:op-old`)).toBeNull();
    // This tab now shows what storage holds, not its stale memory.
    expect(container.textContent).toContain('另一个标签页的新保存');
  });

  it('a saved outcome confirmed by the owner read never clears a newer save stored by another tab', async () => {
    store(revision, { annotation: pendingOld('op-old', 1) });
    const landed = view(true);
    landed.review.annotations = landed.review.annotations.map((annotation) => ({
      ...annotation,
      operationId: 'op-old',
    }));
    let reads = 0;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/workspace/content-reviews/prepare' || url === `/api/workspace/content-reviews/${reviewId}`)
        return new Response(JSON.stringify(reads++ === 0 ? view() : landed));
      throw new Error(`unexpected route: ${url}`);
    });
    await act(async () => {
      root.render(
        <WorkspaceContentReviewSurface
          worktreeId="worktree-a"
          path="notes.md"
          sourceText={sourceText}
          sourceTextRevision={revision}
          onBack={vi.fn()}
        />,
      );
    });
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
    store(revision, { annotation: { ...pendingOld('op-new', 3), body: '另一个标签页的新保存' } });
    await act(async () => button('核对保存结果')?.click());
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
    expect(stored(revision)).toMatchObject({ annotation: { operationId: 'op-new', body: '另一个标签页的新保存' } });
    expect(container.textContent).toContain('被别处改动过');
  });

  it.each(
    keys,
  )('on %s, a continued card never clears a draft that changed after the card was opened', async (_name, sourceRevision) => {
    store(sourceRevision, { body: '打开卡片时的草稿', target: { kind: 'text_quote', quote } });
    await render(view());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-legacy-text-continue"]')?.click(),
    );
    store(sourceRevision, { body: '之后在别处改成了这样', target: { kind: 'text_quote', quote } });
    const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="context-annotation-comment"]');
    await act(async () =>
      editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    // The person's card still reaches chat; the changed draft is kept, and the status says why.
    expect(useChatStore.getState().pendingChatInsert?.contextAttachments?.[0]).toMatchObject({
      comment: '打开卡片时的草稿',
    });
    expect(stored(sourceRevision)).toMatchObject({ body: '之后在别处改成了这样' });
    expect(container.textContent).toContain('没有清除它');
  });

  // Sol #4747 review P2 (both rounds): the owner's answer and the local write are separate facts, and a write
  // that failed leaves this tab showing exactly what storage still holds.
  it.each(
    keys,
  )('on %s, a proven outcome that cannot be written locally is not reported as continuable', async (_name, sourceRevision) => {
    store(sourceRevision, { annotation: pendingOld('op-old', 1) });
    await render(view(true));
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === keyOf(sourceRevision)) throw new Error('quota');
      return setItem.call(this, key, value);
    });
    await act(async () => button('核对保存结果')?.click());
    for (let i = 0; i < 4; i += 1) await act(async () => Promise.resolve());
    expect(container.textContent).toContain('浏览器没能记下这个结果');
    expect(container.textContent).not.toContain('可以续到批注卡');
    expect(stored(sourceRevision)).toMatchObject({ annotation: { operationId: 'op-old' } });
    expect(container.querySelector('[data-testid="workspace-legacy-text-continue"]')).toBeNull();
    expect(button('核对保存结果')).toBeDefined();
  });
});
