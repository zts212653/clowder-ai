import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { ChatContainerHeader } from '../ChatContainerHeader';
import { composerPopoverPosition } from '../ComposerPopover';
import { ThreadCatPill } from '../ThreadCatPill';
import { ThreadComposerContext } from '../ThreadComposerContext';
import { ThreadIndicator } from '../ThreadIndicator';

const api = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: vi.fn() }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => undefined, getCatsByBreed: () => new Map() }),
  formatCatName: (cat: { displayName: string }) => cat.displayName,
}));
vi.mock('../shell/ConversationViewMenu', () => ({ ConversationViewMenu: () => <button type="button">群聊</button> }));
vi.mock('../shell/HeaderCounts', () => ({ ThreadTasksButton: () => null, ThreadWorksButton: () => null }));
vi.mock('../execution-row/ThreadTitleResetMenu', () => ({ ThreadTitleResetMenu: () => null }));
vi.mock('../MemberSessionStrategy', () => ({ MemberSessionStrategy: () => null }));
vi.mock('../ThreadSidebar/CatSelector', () => ({
  CatSelector: ({
    selectedCats,
    onSelectionChange,
  }: {
    selectedCats: string[];
    onSelectionChange: (cats: string[]) => void;
  }) => (
    <button
      type="button"
      aria-pressed={selectedCats.includes('codex-astra')}
      onClick={() => onSelectionChange([...selectedCats, 'codex-astra'])}
    >
      Astra
    </button>
  ),
}));

let root: Root;
let host: HTMLDivElement;
const thread = {
  id: 'thread-a',
  title: '原对话',
  projectPath: '/projects/exact-project',
  preferredCats: [],
  createdBy: 'owner',
  participants: [],
  lastActiveAt: 1,
  createdAt: 1,
  pinned: false,
  favorited: false,
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  writeShellPresentation('v2');
  writeShellLanguage('zh');
  useChatStore.setState({ threads: [thread], currentThreadId: 'thread-a', currentProjectPath: '/wrong/global' });
  useSidebarProjectionStore.setState({ rows: [], pendingThreadCommands: {} });
  api.mockReset();
  api.mockResolvedValue({ ok: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('conversation controls keep their distinct owners', () => {
  it('makes the truncated header title recoverable by keyboard without a native tooltip', async () => {
    const matches = Element.prototype.matches;
    const focusVisible = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      return selector === ':focus-visible' || matches.call(this, selector);
    });
    try {
      await act(async () => root.render(<ThreadIndicator threadId="thread-a" showProject={false} />));
      const title = host.querySelector('button') as HTMLButtonElement;
      expect(title.hasAttribute('title')).toBe(false);
      act(() => title.focus());
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('原对话');
      act(() => writeShellLanguage('en'));
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Double-click to edit title');
      expect(host.querySelector('button')).toBe(title);
    } finally {
      focusVisible.mockRestore();
    }
  });
  it('reads and copies only the conversation project, keeping the menu read-only', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await act(async () => root.render(<ThreadComposerContext threadId="thread-a" />));
    const project = host.querySelector('[data-testid="composer-project"]') as HTMLButtonElement;
    expect(host.querySelector('[data-testid="thread-cat-pill"]')).toBeNull();
    expect(project.getAttribute('aria-label')).toBe('项目: /projects/exact-project');
    act(() => project.click());
    expect(document.querySelector('[data-testid="composer-project-full-path"]')?.textContent).toBe(
      '/projects/exact-project',
    );
    const copy = document.querySelector('[role="dialog"] button') as HTMLButtonElement;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith('/projects/exact-project');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('已复制');
    act(() => writeShellLanguage('en'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Copy path');
    expect(api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    expect(useChatStore.getState().currentProjectPath).toBe('/wrong/global');
  });

  it('reads an omitted carrier by exact id and never substitutes another thread on failure', async () => {
    useChatStore.setState({ threads: [] });
    api.mockImplementation(async (url) => ({
      ok: true,
      json: async () => ({
        id: url.endsWith('missing') ? 'other' : 'carrier',
        title: 'Carrier',
        projectPath: '/projects/carrier',
        preferredCats: [],
      }),
    }));
    await act(async () => root.render(<ThreadComposerContext threadId="carrier" />));
    expect(host.querySelector('[data-testid="composer-project"]')?.getAttribute('aria-label')).toBe(
      '项目: /projects/carrier',
    );
    await act(async () => root.render(<ThreadComposerContext threadId="missing" />));
    expect(host.querySelector('[data-testid="composer-project"]')?.getAttribute('aria-label')).toBe('项目: 项目不可用');
    expect(host.textContent).not.toContain('carrier');
    expect(api).toHaveBeenCalledWith('/api/threads/missing');
  });

  it('saves the preferred send cat through the original field, without writing viewing mode', async () => {
    api.mockResolvedValue({ ok: true });
    await act(async () => root.render(<ThreadCatPill threadId="thread-a" presentation="composer" />));
    const trigger = host.querySelector('[data-testid="thread-cat-pill"]') as HTMLButtonElement;
    act(() => trigger.click());
    const choose = document.querySelector('[role="dialog"] button') as HTMLButtonElement;
    act(() => choose.click());
    const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === '保存',
    );
    await act(async () => save?.click());
    expect(api).toHaveBeenCalledWith(
      '/api/threads/thread-a',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ preferredCats: ['codex-astra'] }) }),
    );
    expect(useChatStore.getState().threads[0]?.preferredCats).toEqual(['codex-astra']);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('retains the selected cat after save failure and cancels without a second write', async () => {
    await act(async () => root.render(<ThreadCatPill threadId="thread-a" presentation="composer" />));
    act(() => (host.querySelector('[data-testid="thread-cat-pill"]') as HTMLButtonElement).click());
    act(() => (document.querySelector('[role="dialog"] button') as HTMLButtonElement).click());
    const action = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (button) => button.textContent === text,
      );
    await act(async () => action('保存')?.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('保存失败');
    expect(document.querySelector('[role="dialog"] button')?.getAttribute('aria-pressed')).toBe('true');
    act(() => action('取消')?.click());
    expect(api.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    expect(useChatStore.getState().threads[0]?.preferredCats).toEqual([]);
  });

  it('clamps a bottom-anchored popover inside a narrow viewport', () => {
    const position = composerPopoverPosition({ top: 400, left: 240 }, 260, 600);
    expect(position.width).toBe(244);
    expect(position.left).toBe(8);
    expect(position.bottom).toBe(206);
    expect(position.maxHeight).toBeLessThan(400);
  });

  it('accepts a wider project browser while still clamping to the viewport', () => {
    expect(composerPopoverPosition({ top: 500, left: 120 }, 900, 700, 560)).toMatchObject({
      width: 560,
      left: 120,
      bottom: 206,
    });
    expect(composerPopoverPosition({ top: 500, left: 120 }, 390, 700, 560).width).toBe(374);
  });
  it('moves project and preferred send cat out of the v2 header while retaining the viewing mode', async () => {
    await act(async () =>
      root.render(
        <ChatContainerHeader
          sidebarOpen
          onToggleSidebar={vi.fn()}
          threadId="thread-a"
          viewMode="single"
          onToggleViewMode={vi.fn()}
          statusPanelOpen={false}
          onToggleStatusPanel={vi.fn()}
        />,
      ),
    );
    expect(host.textContent).toContain('原对话');
    expect(host.textContent).toContain('群聊');
    expect(host.textContent).not.toContain('exact-project');
    expect(host.querySelector('[data-testid="thread-cat-pill"]')).toBeNull();
    act(() => writeShellPresentation('classic'));
    expect(host.textContent).toContain('exact-project');
    expect(host.querySelector('[data-testid="thread-cat-pill"]')).not.toBeNull();
  });

  it('opens the composer cat control above its trigger, translates in place and closes with keyboard focus restored', async () => {
    await act(async () => root.render(<ThreadCatPill threadId="thread-a" presentation="composer" />));
    const trigger = host.querySelector('[data-testid="thread-cat-pill"]') as HTMLButtonElement;
    trigger.getBoundingClientRect = () => ({
      top: 600,
      bottom: 632,
      left: 370,
      right: 420,
      width: 50,
      height: 32,
      x: 370,
      y: 600,
      toJSON() {},
    });
    act(() => trigger.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect((dialog as HTMLElement).style.bottom).not.toBe('');
    expect(dialog?.textContent).toContain('保存');
    act(() => writeShellLanguage('en'));
    expect(dialog?.textContent).toContain('Save');
    expect(host.querySelector('[data-testid="thread-cat-pill"]')).toBe(trigger);
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(api.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
});
