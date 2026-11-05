import type { ContextAttachment, MediaContextAttachment } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ContextAttachmentList, ContextAttachmentView } from '@/components/ContextAttachmentView';
import { applyContextAttachmentDelta } from '@/components/durable-composer-draft-merge';
import { getContextAttachmentDraft, syncContextAttachmentDraftToStorage } from '@/components/thread-drafts';
import { useChatStore } from '@/stores/chatStore';

const THREAD = 'thread-media-leaf';
const media = (selections: MediaContextAttachment['selections']): MediaContextAttachment => ({
  v: 1,
  id: 'media-1',
  kind: 'media',
  title: '窄屏设计稿',
  mediaType: 'image/png',
  source: {
    kind: 'workspace',
    locator: { worktreeId: 'wt-1', path: 'art/cover.png' },
    expectedSourceRevision: `sha256:${'a'.repeat(64)}`,
    reviewId: 'review-1',
    expectedReviewRevision: 3,
  },
  selections,
});
const TWO = media([
  {
    id: '1',
    selection: { kind: 'image-region', x: 411, y: 622, width: 733, height: 144 },
    instruction: '移除这里的字',
  },
  { id: '2', selection: { kind: 'image-point', x: 987, y: 654 } },
]);

describe('a media attachment reads as the places the person circled', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    syncContextAttachmentDraftToStorage(THREAD, []);
    useChatStore.setState({ currentThreadId: THREAD, pendingChatInsert: null });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = (node: React.ReactNode) => act(() => root.render(node));
  const text = () => container.textContent ?? '';
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it('lets the reader recover the frozen paragraph quote from a video place', () => {
    const attachment: MediaContextAttachment = {
      ...media([]),
      mediaType: 'video/mp4',
      selections: [
        {
          id: '1',
          selection: {
            kind: 'video-range',
            streamId: '0',
            startTick: 12,
            endTick: 24,
            storyEvidence: { paragraphId: 'original', metadataRevision: 3, quote: '原话第一行\n原话第二行' },
          },
        },
      ],
    };
    render(<ContextAttachmentView attachment={attachment} />);
    expect(text()).toContain('段落');
    const quote = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    expect(quote?.textContent).toContain('原文');
    act(() => quote?.click());
    expect(text()).toContain('原话第一行\n原话第二行');
  });

  it('in a sent message, numbers each place, says what was done there and shows the words for it', () => {
    render(<ContextAttachmentView attachment={TWO} />);
    expect(text()).toContain('窄屏设计稿');
    expect(text()).toContain('图片 · 2处选区');
    const rows = [...container.querySelectorAll('[data-selection-id]')];
    expect(rows.map((row) => row.getAttribute('data-selection-id'))).toEqual(['1', '2']);
    expect(rows[0]?.textContent).toContain('1');
    expect(rows[0]?.textContent).toContain('圈选');
    expect(rows[0]?.textContent).toContain('移除这里的字');
    expect(rows[1]?.textContent).toContain('2');
    expect(rows[1]?.textContent).toContain('点选');
  });

  it('never shows coordinates, and offers nothing to remove or click in a sent message', () => {
    render(<ContextAttachmentView attachment={TWO} />);
    expect(text()).not.toMatch(/411|622|733|144|987|654|image-region|image-point|sha256|review-1/);
    expect(container.querySelector('button')).toBeNull();
  });

  it('says whole work when no place was circled, with no numbered places', () => {
    render(<ContextAttachmentView attachment={media([])} />);
    expect(text()).toContain('图片 · 整件作品');
    expect(container.querySelector('[data-selection-id]')).toBeNull();
  });

  it('numbers the places by their order, not by their stable ids', () => {
    const survivors = media([
      { id: '2', selection: { kind: 'image-point', x: 1, y: 1 } },
      { id: '3', selection: { kind: 'image-region', x: 1, y: 1, width: 5, height: 5 } },
    ]);
    render(<ContextAttachmentView attachment={survivors} />);
    const rows = [...container.querySelectorAll('[data-selection-id]')];
    expect(rows.map((row) => row.getAttribute('data-selection-id'))).toEqual(['2', '3']);
    expect(rows.map((row) => row.querySelector('[data-testid="media-selection-number"]')?.textContent)).toEqual([
      '1',
      '2',
    ]);
  });

  it('in the composer, takes one place away through the same composer path and leaves the other with its id', () => {
    syncContextAttachmentDraftToStorage(THREAD, [TWO]);
    render(<ContextAttachmentList compact attachments={[TWO]} onRemove={() => undefined} />);
    expect(button('移除选区 1')).not.toBeNull();
    act(() => button('移除选区 1')?.click());
    const queued = useChatStore.getState().pendingChatInsert;
    expect(queued?.threadId).toBe(THREAD);
    expect(queued?.removeContextAttachmentIds).toEqual(['media-1']);
    const next = applyContextAttachmentDelta(
      getContextAttachmentDraft(THREAD),
      queued?.contextAttachments ?? [],
      new Set(queued?.removeContextAttachmentIds ?? []),
    );
    expect((next[0] as MediaContextAttachment).selections.map((item) => item.id)).toEqual(['2']);
  });

  it('in the composer, removing the last place removes the attachment instead of leaving the whole work', () => {
    const one = media([{ id: '1', selection: { kind: 'image-point', x: 1, y: 1 } }]);
    syncContextAttachmentDraftToStorage(THREAD, [one]);
    render(<ContextAttachmentList compact attachments={[one]} onRemove={() => undefined} />);
    act(() => button('移除选区 1')?.click());
    const queued = useChatStore.getState().pendingChatInsert;
    expect(queued?.removeContextAttachmentIds).toEqual(['media-1']);
    expect(queued?.contextAttachments ?? []).toEqual([]);
  });

  it('in the composer, takes a place from the attachment that shows it, not from the first one', () => {
    const second: MediaContextAttachment = { ...TWO, id: 'media-2' };
    syncContextAttachmentDraftToStorage(THREAD, [TWO, second]);
    render(<ContextAttachmentList compact attachments={[TWO, second]} onRemove={() => undefined} />);
    const buttons = container.querySelectorAll<HTMLButtonElement>('button[aria-label="移除选区 1"]');
    expect(buttons).toHaveLength(2);
    act(() => buttons[1]?.click());
    expect(useChatStore.getState().pendingChatInsert?.removeContextAttachmentIds).toEqual(['media-2']);
  });

  it('keeps the attachment-level remove for the whole attachment', () => {
    const removed: string[] = [];
    render(
      <ContextAttachmentList compact attachments={[TWO as ContextAttachment]} onRemove={(id) => removed.push(id)} />,
    );
    act(() => button('移除上下文 窄屏设计稿')?.click());
    expect(removed).toEqual(['media-1']);
  });

  it('only shows per-place remove where the attachment can be removed at all', () => {
    render(<ContextAttachmentView compact attachment={TWO} />);
    expect(button('移除选区 1')).toBeNull();
  });
});
