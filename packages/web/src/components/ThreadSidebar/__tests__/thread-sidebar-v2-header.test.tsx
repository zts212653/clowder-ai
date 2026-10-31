import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '../../shell/shell-language';
import { ThreadSidebarV2Header } from '../ThreadSidebarV2Header';

describe('F322 sidebar v2 recovery controls', () => {
  let host: HTMLDivElement;
  let root: Root;
  const actions = {
    onNewThread: vi.fn(),
    onCollapse: vi.fn(),
    onOrganizeWithCat: vi.fn(),
    onOpenOrganizer: vi.fn(),
    onOpenBootcamp: vi.fn(),
    onMarkAllRead: vi.fn(),
  };
  function render(
    phase: 'idle' | 'submitting' | 'reconciling' = 'idle',
    marking = false,
    uncategorized = 12,
    unread = 4,
  ) {
    function Header() {
      const [query, setQuery] = useState('');
      return (
        <ThreadSidebarV2Header
          {...actions}
          creationPhase={phase}
          searchQuery={query}
          onSearchQueryChange={setQuery}
          uncategorizedCount={uncategorized}
          unreadCount={unread}
          isMarkingAllRead={marking}
        />
      );
    }
    act(() => root.render(<Header />));
  }
  function button(id: string) {
    const found = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    if (!found) throw new Error(`Sidebar control ${id} is missing`);
    return found;
  }
  function click(id: string) {
    act(() => button(id).click());
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    writeShellLanguage('zh');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellLanguage('zh');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('switches the production header, search and recovery actions to English without losing search state', () => {
    render('reconciling', false, 1, 4);
    click('sidebar-search-toggle');
    const input = button('sidebar-search-input') as unknown as HTMLInputElement;
    act(() => writeShellLanguage('en'));
    expect(host.querySelector('h2')?.textContent).toBe('My Café');
    expect(button('sidebar-new-thread').textContent).toContain('New conversation');
    expect(button('sidebar-new-thread').textContent).toContain('Request timed out, checking…');
    expect(button('sidebar-all-works').textContent).toBe('All works');
    expect(button('sidebar-memory').textContent).toBe('Memory');
    expect(input.placeholder).toBe('Search conversations, projects or ID…');
    expect(document.activeElement).toBe(input);
    click('sidebar-more-menu');
    expect(host.querySelector('[role="menu"]')?.textContent).toContain('Ask a cat to organize (1 uncategorized)');
    expect(host.querySelector('[role="menu"]')?.textContent).toContain('Organize manually (1 uncategorized)');
    expect(button('sidebar-bootcamp').querySelector('.min-w-0')?.textContent).toBe('Cat bootcamp');
    expect(button('sidebar-bootcamp').querySelector('svg title')?.textContent).toBe('Cat bootcamp');
    expect(button('mark-all-read-btn').textContent).toBe('Mark all as read (4)');
    expect(button('sidebar-collapse').getAttribute('aria-label')).toBe('Collapse sidebar');
    expect(host.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    act(() => writeShellLanguage('zh'));
    expect(host.querySelector('h2')?.textContent).toBe('我的 Café');
    expect(host.querySelector('input')).toBe(input);
  });
  it('search toggles, takes focus, and Escape restores the closed state', () => {
    render();
    click('sidebar-search-toggle');
    const input = button('sidebar-search-input');
    expect(document.activeElement).toBe(input);
    expect(button('sidebar-search-toggle').getAttribute('aria-pressed')).toBe('true');
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('input')).toBeNull();
    expect(button('sidebar-search-toggle').getAttribute('aria-pressed')).toBe('false');
  });
  it.each([
    ['猫猫帮你分类', 'onOrganizeWithCat'],
    ['手动批量分类', 'onOpenOrganizer'],
    ['猫猫训练营', 'onOpenBootcamp'],
    ['全部标为已读', 'onMarkAllRead'],
  ] as const)('%s remains reachable from More', (label, action) => {
    render();
    click('sidebar-more-menu');
    const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
      b.textContent?.includes(label),
    );
    if (!item) throw new Error(`Recovery action ${label} is missing`);
    act(() => item.click());
    expect(actions[action]).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });
  it('mark-all-read is disabled while submitting and unnecessary recovery actions are absent', () => {
    render('idle', true, 0);
    click('sidebar-more-menu');
    expect(button('mark-all-read-btn').disabled).toBe(true);
    click('mark-all-read-btn');
    expect(actions.onMarkAllRead).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('分类');
  });
  it.each(['submitting', 'reconciling'] as const)('new conversation is disabled during %s', (phase) => {
    render(phase);
    expect(button('sidebar-new-thread').disabled).toBe(true);
    click('sidebar-new-thread');
    expect(actions.onNewThread).not.toHaveBeenCalled();
    if (phase === 'reconciling') expect(button('sidebar-new-thread').textContent).toContain('请求超时，核对中');
  });
  it('idle new conversation and collapse remain usable; v2 header controls have no native title', () => {
    render();
    click('sidebar-new-thread');
    click('sidebar-collapse');
    expect(actions.onNewThread).toHaveBeenCalledOnce();
    expect(actions.onCollapse).toHaveBeenCalledOnce();
    expect(host.querySelector('[title]')).toBeNull();
  });
});
