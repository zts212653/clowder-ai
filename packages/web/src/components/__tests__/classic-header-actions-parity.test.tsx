import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { ChatMessage } from '../ChatMessage';
import { MessageActions } from '../MessageActions';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

const synthesize = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useTextSelectionAction', () => ({ useTextSelectionAction: () => null }));
vi.mock('../useMessageAnnotationMarkers', () => ({ useMessageAnnotationMarkers: () => [] }));
vi.mock('@/hooks/useTts', () => ({ useTts: () => ({ state: 'idle', synthesize, activeMessageId: null }) }));

function required<T extends HTMLElement>(node: T | null | undefined): T {
  if (!node) throw new Error('Expected classic action');
  return node;
}

describe('classic author row and action strip match the runtime reference', () => {
  let h: ReplyLayersHarness;
  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    h = new ReplyLayersHarness();
    synthesize.mockClear();
  });
  afterEach(() => {
    h.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const message = streamReply({
    replyTo: 'source-1',
    replyPreview: { senderCatId: 'codex-astra', content: 'source excerpt' },
  });
  function render(rendered = message) {
    act(() =>
      h.root.render(
        <MessageActions message={rendered} threadId="thread-1" selectionEligible onEnterSelection={vi.fn()}>
          <ChatMessage
            message={rendered}
            threadId="thread-1"
            timelineMessages={[]}
            getCatById={(id) =>
              ({ id, displayName: id, color: { primary: '#659D62', secondary: '#eeeeee' } }) as CatData
            }
          />
        </MessageActions>,
      ),
    );
  }
  it('places the source before the trajectory in the classic author row', () => {
    render();
    const header = required(h.container.querySelector<HTMLElement>('[data-testid="message-header"]'));
    const source = required(
      [...header.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith('↩')),
    );
    const trajectory = required(header.querySelector<HTMLButtonElement>('[data-invocation-anchor]'));
    expect(source.compareDocumentPosition(trajectory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('owns speech and ID controls inside the action strip, followed by reply, selection, branch and delete', () => {
    render();
    const speech = required(h.container.querySelector<HTMLButtonElement>('button[aria-label="播放语音"]'));
    const toolbar = required(speech.closest<HTMLElement>('[role="toolbar"]'));
    const names = [...toolbar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(names.slice(0, 6)).toEqual([
      '播放语音',
      '复制消息 ID: reply-1',
      '引用回复',
      '多选：转发或导出',
      '创建分支',
      '删除',
    ]);
    expect(h.container.querySelectorAll('button[aria-label="播放语音"]')).toHaveLength(1);
    act(() => speech.click());
    expect(synthesize).toHaveBeenCalledWith(message.id, message.content, message.catId);
    const branch = required(toolbar.querySelector<HTMLButtonElement>('button[aria-label="创建分支"]'));
    expect(branch.querySelectorAll('svg circle')).toHaveLength(3);
  });
  it('preserves trajectory access in classic more actions without adding a duplicate inline control', () => {
    render();
    const toolbar = required(h.container.querySelector<HTMLElement>('[role="toolbar"]'));
    expect(toolbar.querySelector('[data-testid="message-action-invocation-trajectory"]')).toBeNull();
    act(() => required(toolbar.querySelector<HTMLButtonElement>('button[aria-label="更多消息操作"]')).click());
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((x) =>
      x.textContent?.includes('查看这轮轨迹'),
    );
    expect(item).toBeTruthy();
  });
  it('keeps a portaled compact action sheet in normal flow, separate from the author slot', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width: 767px'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render();
    act(() =>
      required(h.container.querySelector<HTMLButtonElement>('[data-testid="message-actions-compact-trigger"]')).click(),
    );
    const sheet = required(document.querySelector<HTMLElement>('[data-testid="message-actions-compact-sheet"]'));
    const toolbar = required(sheet.querySelector<HTMLElement>('[role="toolbar"]'));
    expect(toolbar.classList.contains('absolute')).toBe(false);
    expect([...toolbar.classList].some((token) => token.includes('translate-y'))).toBe(false);
    expect(toolbar.querySelector('button[aria-label="播放语音"]')).toBeTruthy();
  });
  it('keeps a trajectory control for non-assistant notices that have no assistant author anchor', () => {
    render({ ...message, type: 'system' });
    expect(h.container.querySelector('[data-testid="message-action-invocation-trajectory"]')).toBeTruthy();
    expect(h.container.querySelector('button[aria-label="播放语音"]')).toBeNull();
  });
  it('keeps the v2 action overlay and does not put classic speech in its author row', () => {
    h.enableV2();
    render();
    expect(h.container.querySelector('button[aria-label="播放语音"]')).toBeNull();
    expect(document.querySelector('[data-message-actions-owner="reply-1"]')).toBeTruthy();
  });
});
