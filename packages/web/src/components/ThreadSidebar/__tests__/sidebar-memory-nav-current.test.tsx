import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/memory', push: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push }),
}));

import { ThreadSidebarV2Header } from '../ThreadSidebarV2Header';

describe('F322 sidebar 记忆 row knows when it is the current destination', () => {
  let host: HTMLDivElement;
  let root: Root;
  function render(activeDestination?: 'memory' | null) {
    act(() =>
      root.render(
        <ThreadSidebarV2Header
          creationPhase="idle"
          onNewThread={vi.fn()}
          searchQuery=""
          onSearchQueryChange={vi.fn()}
          uncategorizedCount={0}
          onOrganizeWithCat={vi.fn()}
          onOpenOrganizer={vi.fn()}
          onOpenBootcamp={vi.fn()}
          unreadCount={0}
          isMarkingAllRead={false}
          onMarkAllRead={vi.fn()}
          activeDestination={activeDestination}
        />,
      ),
    );
  }
  const row = (id: string) => {
    const found = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    if (!found) throw new Error(`${id} is missing`);
    return found;
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    nav.push.mockReset();
    nav.pathname = '/memory';
    window.history.replaceState(null, '', '/memory');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.history.replaceState(null, '', '/');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('marks 记忆 as the current page, in a way both assistive tech and the eye can read', () => {
    render('memory');
    const memory = row('sidebar-memory');
    expect(memory.getAttribute('aria-current')).toBe('page');
    expect(memory.getAttribute('data-selected')).toBe('true');
    expect(memory.style.background).toContain('--shell-selected');
    expect(memory.style.color).toContain('--shell-ink');
  });

  it('marks nothing on a conversation, and never marks the other two rows', () => {
    render(null);
    for (const id of ['sidebar-memory', 'sidebar-new-thread', 'sidebar-all-works']) {
      expect(row(id).hasAttribute('aria-current')).toBe(false);
      expect(row(id).hasAttribute('data-selected')).toBe(false);
    }
    render('memory');
    expect(row('sidebar-new-thread').hasAttribute('aria-current')).toBe(false);
    expect(row('sidebar-all-works').hasAttribute('aria-current')).toBe(false);
  });

  it('from a memory sub-page the row goes back to the memory home and keeps the way back to the conversation', () => {
    nav.pathname = '/memory/search';
    window.history.replaceState(null, '', '/memory/search?from=thread-origin');
    render('memory');
    act(() => row('sidebar-memory').click());
    expect(nav.push).toHaveBeenCalledWith('/memory?from=thread-origin');
  });
});
