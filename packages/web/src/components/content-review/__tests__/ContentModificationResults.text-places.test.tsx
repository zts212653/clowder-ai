import type { ContentModificationDetailView } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContentModificationResults } from '../ContentModificationResults';

const baseRevision = `sha256:${'a'.repeat(64)}`;
const selection = (id: string, quote: string, start: number) => ({
  id,
  selection: {
    kind: 'text_quote' as const,
    baseRevision,
    start,
    end: start + quote.length,
    quote,
    quoteDigest: 'a'.repeat(64),
    contextDigest: 'b'.repeat(64),
  },
  instruction: `说明 ${id}`,
});
const view: ContentModificationDetailView = {
  stage: 'queued',
  record: {
    requestId: `f309-modification-${'b'.repeat(64)}`,
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    progress: {},
    payload: {
      operationId: crypto.randomUUID(),
      targetCatId: 'codex-astra',
      threadId: 'thread',
      source: {
        kind: 'workspace',
        locator: { worktreeId: 'work', path: 'guide.md' },
        reviewId: 'review',
        expectedReviewRevision: 1,
        expectedSourceRevision: baseRevision,
      },
      intent: { body: '修改这两处', selections: [selection('first', 'Two', 4), selection('second', 'One', 0)] },
    },
  },
  candidates: [
    {
      kind: 'text',
      candidateRef: 'candidate',
      proposal: {
        proposalRef: 'candidate',
        requestId: `f309-modification-${'b'.repeat(64)}`,
        revision: 1,
        operationId: 'return',
        baseRevision,
        resultRevision: `sha256:${'c'.repeat(64)}`,
        response: '已提出修改',
        authorCatId: 'codex-astra',
        createdAt: 2,
        receiptRef: 'receipt',
        // Patch order need not equal quote order; the source selection id is the binding.
        edits: [
          { selectionId: 'second', start: 0, end: 3, expectedText: 'One', replacement: 'First' },
          { selectionId: 'first', start: 4, end: 7, expectedText: 'Two', replacement: 'Second' },
          { start: 8, end: 13, expectedText: 'extra', replacement: 'Extra' },
        ],
      },
    },
  ],
  acceptances: [],
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = async (value = view) => {
  await act(async () => root.render(<ContentModificationResults view={value} busy={false} onAccept={vi.fn()} />));
  return [...container.querySelectorAll('[data-text-edit]')];
};

it('binds every before/after pair to the original quote number, even when patch order differs', async () => {
  const edits = await render();
  expect(edits.map((edit) => edit.getAttribute('data-selection-id'))).toEqual(['second', 'first', null]);
  expect(edits[0]?.textContent).toContain('第 2 处');
  expect(edits[0]?.textContent).toContain('说明 second');
  expect(edits[1]?.textContent).toContain('第 1 处');
  expect(edits[1]?.textContent).toContain('说明 first');
  expect(edits[2]?.textContent).toContain('未关联引用的修改');
  expect(edits[0]?.querySelector('del')?.textContent).toBe('One');
  expect(edits[0]?.querySelector('ins')?.textContent).toBe('First');
});

it('does not guess a quote from offsets when the edit has no matching selection id', async () => {
  const value = structuredClone(view);
  const candidate = value.candidates[0];
  if (candidate.kind !== 'text') throw new Error('text fixture required');
  candidate.proposal.edits = [{ selectionId: 'unknown', start: 0, end: 3, expectedText: 'One', replacement: 'First' }];
  const edits = await render(value);
  expect(edits[0]?.textContent).toContain('未关联引用的修改');
  expect(container.textContent).not.toContain('第 1 处');
});

it('keeps a legacy candidate without named quotes reviewable, without inventing a numbered source', async () => {
  const value = structuredClone(view);
  value.record.payload.intent = { body: '更新说明书' };
  const edits = await render(value);
  expect(edits).toHaveLength(3);
  expect(edits.every((edit) => edit.textContent?.includes('未关联引用的修改'))).toBe(true);
  expect(container.querySelector('[data-testid="content-modification-accept"]')).not.toBeNull();
});

it('focuses a text candidate inside its viewport without scrolling the file header out of reach', async () => {
  container.dataset.workspaceTextComparison = '';
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const globalScroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: globalScroll, configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this === container ? new DOMRect(0, 100, 300, 400) : new DOMRect(0, 250, 300, 600);
  });
  try {
    await act(async () =>
      root.render(
        <ContentModificationResults view={view} busy={false} onAccept={vi.fn()} focusCandidateRef="candidate" />,
      ),
    );
    expect(container.scrollTop).toBe(150);
    expect(globalScroll).not.toHaveBeenCalled();
  } finally {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    vi.restoreAllMocks();
  }
});

it('keeps the human decision outcome in the text viewport, including after a file refresh remount', async () => {
  container.dataset.workspaceTextComparison = '';
  const applied = structuredClone(view);
  const source = applied.record.payload.source;
  if (source.kind !== 'workspace') throw new Error('workspace fixture required');
  const acceptance = {
    requestId: applied.record.requestId,
    ownerUserId: 'operator',
    acceptOperationId: 'accept',
    candidateRef: 'candidate',
    baseRevision,
    locator: source.locator,
    humanReceiptRef: 'human-accept',
    fileReceiptRef: 'writeback',
    acceptedAt: 3,
  };
  applied.acceptances = [
    {
      acceptance,
      receipt: {
        ...acceptance,
        receiptRef: 'writeback',
        candidateRevision: `sha256:${'c'.repeat(64)}`,
        state: 'applied',
        writtenRevision: `sha256:${'c'.repeat(64)}`,
        currentRevision: `sha256:${'c'.repeat(64)}`,
      },
    },
  ];
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this === container ? 100 : (this.textContent === '已写回原文件' ? 700 : 250) - container.scrollTop;
    return new DOMRect(0, top, 300, this === container ? 400 : 30);
  });
  try {
    await act(async () =>
      root.render(
        <ContentModificationResults view={view} busy={false} onAccept={vi.fn()} focusCandidateRef="candidate" />,
      ),
    );
    await act(async () =>
      root.render(
        <ContentModificationResults view={applied} busy={false} onAccept={vi.fn()} focusCandidateRef="candidate" />,
      ),
    );
    expect(container.querySelector('output')?.getBoundingClientRect().top).toBe(100);
    await act(async () =>
      root.render(
        <ContentModificationResults
          key="refreshed"
          view={applied}
          busy={false}
          onAccept={vi.fn()}
          focusCandidateRef="candidate"
        />,
      ),
    );
    expect(container.querySelector('output')?.getBoundingClientRect().top).toBe(100);
    container.scrollTop = 250;
    await act(async () =>
      root.render(
        <ContentModificationResults
          key="refreshed"
          view={structuredClone(applied)}
          busy={false}
          onAccept={vi.fn()}
          focusCandidateRef="candidate"
        />,
      ),
    );
    expect(container.scrollTop, 'a repeated owner read does not take the scroll back from the reader').toBe(250);
  } finally {
    vi.restoreAllMocks();
  }
});
