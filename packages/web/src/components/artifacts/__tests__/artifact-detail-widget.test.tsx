import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const widgetState = vi.hoisted(() => ({
  value: { state: { status: 'idle' }, reload: vi.fn() } as {
    state: { status: string; block?: unknown };
    reload: () => void;
  },
}));

vi.mock('@/hooks/useArtifactWidgetBlock', () => ({ useArtifactWidgetBlock: () => widgetState.value }));
vi.mock('../ArtifactWidgetFrame', () => ({
  ArtifactWidgetFrame: ({ block }: { block: { id: string } }) => (
    <div data-testid="html-widget-block" data-block-id={block.id} />
  ),
}));

import { ArtifactDetailView } from '../ArtifactDetailView';

const artifact: ThreadArtifactDTO = {
  type: 'widget',
  name: '落地页',
  catId: 'opus-48',
  createdAt: 1_700_000_000_000,
  sourceMessageId: 'msg-1',
  widgetBlockId: 'block-a',
};

let host: HTMLDivElement;
let root: Root;

function render(overrides: Partial<ThreadArtifactDTO> = {}, onJump = vi.fn()) {
  act(() => {
    root.render(
      createElement(ArtifactDetailView, {
        artifact: { ...artifact, ...overrides },
        threadId: null,
        worktreeId: null,
        onBack: () => undefined,
        onJump,
        sourceThreadId: 'thread-1',
      } as never),
    );
  });
  return { onJump };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  widgetState.value = { state: { status: 'idle' }, reload: vi.fn() };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('F232 PR-A ArtifactDetailView widget preview', () => {
  it('renders the exact block returned for the coordinate', () => {
    widgetState.value = {
      state: { status: 'ready', block: { id: 'block-a', kind: 'html_widget', v: 1, html: '<p>x</p>' } },
      reload: vi.fn(),
    };
    render();
    const block = host.querySelector('[data-testid="html-widget-block"]');
    expect(block?.getAttribute('data-block-id')).toBe('block-a');
    expect(host.querySelector('[data-artifact-widget-body]')).toBeTruthy();
  });

  it('shows the unavailable state and keeps the original-message exit', () => {
    widgetState.value = { state: { status: 'unavailable' }, reload: vi.fn() };
    const { onJump } = render();
    expect(host.textContent).toContain('找不到这个 HTML 块，或你没有查看权限');
    expect(host.querySelector('[data-testid="html-widget-block"]')).toBeNull();
    const backToMessage = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('回原消息'),
    );
    act(() => backToMessage?.click());
    expect(onJump).toHaveBeenCalledWith('msg-1');
  });

  it('does not fetch or preview when the artifact has no HTML coordinate', () => {
    const { onJump } = render({ widgetBlockId: undefined });
    expect(host.textContent).toContain('没有可预览的 HTML 坐标');
    expect(host.querySelector('[data-testid="html-widget-block"]')).toBeNull();
    expect(onJump).not.toHaveBeenCalled();
  });

  it('reports a read failure honestly and offers retry', () => {
    const reload = vi.fn();
    widgetState.value = { state: { status: 'error' }, reload };
    render();
    expect(host.textContent).toContain('读取 HTML 正文失败');
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === '重试');
    act(() => retry?.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
