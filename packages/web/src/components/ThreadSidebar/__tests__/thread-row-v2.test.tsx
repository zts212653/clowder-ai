import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidebarPresence } from '@/stores/sidebarProjectionStore';

const cats = vi.hoisted(() =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `known-${i}`,
    displayName: `伙伴${i + 1}`,
    color: { primary: '#777777' },
  })),
);
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: (id: string) => cats.find((cat) => cat.id === id) }),
}));
vi.mock('@/stores/label-store', () => ({ useLabelStore: () => ({ labels: [] }) }));
vi.mock('../sidebar-draft-decoration', () => ({ useSidebarDraftDecoration: () => true }));
vi.mock('../ThreadSettingsPanel', () => ({ ThreadSettingsPanel: () => null }));
vi.mock('@/components/ExportButton', () => ({ ExportButton: () => null }));

import { writeShellPresentation } from '../../shell/shell-presentation';
import { ThreadItem } from '../ThreadItem';
import { ThreadRowSignals } from '../ThreadRowSignals';

describe('F322 v2 row facts and recoverable names', () => {
  let host: HTMLDivElement;
  let root: Root;
  const title = '同一个很长很长的中文项目标题：'.repeat(8);
  const onSelect = vi.fn();
  function renderItem(presence: SidebarPresence = { status: 'idle' }, participants = cats.map((cat) => cat.id)) {
    act(() =>
      root.render(
        <ThreadItem
          id="conversation"
          title={`${title}第一段`}
          participants={participants}
          lastActiveAt={Date.now() - 60_000}
          isActive={false}
          onSelect={onSelect}
          onTogglePin={vi.fn()}
          presence={presence}
          unreadCount={5}
          hasUserMention
        />,
      ),
    );
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    writeShellPresentation('v2');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' || matches.call(this, selector);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each(['error', 'working', 'done'] as const)('%s coexists with mention, unread, and draft', (status) => {
    renderItem({ status, cats: cats.map((cat) => cat.id), activeSince: Date.now() - 120_000 });
    expect(host.querySelector(`[data-testid="thread-row-${status}"]`)).not.toBeNull();
    expect(host.querySelector('[data-testid="thread-row-mention"]')?.textContent).toBe('@你');
    expect(host.querySelector('[data-testid="thread-row-unread"]')?.textContent).toContain('5');
    expect(host.querySelector('[data-testid="thread-row-draft"]')?.textContent).toBe('草稿');
    if (status === 'working') expect(host.textContent).toContain('等 12 只猫正在工作');
    act(() => host.querySelector<HTMLElement>('[data-thread-id]')?.click());
    expect(onSelect).toHaveBeenCalledWith('conversation');
  });
  it('quiet twelve-cat conversations retain all participant names through keyboard title recovery', () => {
    renderItem();
    const titleElement = [...host.querySelectorAll<HTMLElement>('span')].find(
      (el) => el.textContent === `${title}第一段` && !el.querySelector('span'),
    );
    if (!titleElement) throw new Error('Conversation title is missing');
    act(() => titleElement.focus());
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip, 'keyboard focus must reveal the full roster').not.toBeNull();
    for (const cat of cats) expect(tip?.textContent ?? '').toContain(cat.displayName);
  });
  it('v2 row controls and full-title recovery do not use native title', () => {
    renderItem();
    expect(host.querySelector('[title]')).toBeNull();
  });
  it('long same-prefix titles can be recovered by keyboard focus through the name tip', () => {
    act(() =>
      root.render(
        ['第一段', '第二段'].map((suffix) => (
          <ThreadItem
            key={suffix}
            id={suffix}
            title={`${title}${suffix}`}
            participants={cats.map((cat) => cat.id)}
            lastActiveAt={Date.now()}
            isActive={false}
            onSelect={onSelect}
            presence={{ status: 'idle' }}
            unreadCount={0}
            hasUserMention={false}
          />
        )),
      ),
    );
    for (const suffix of ['第一段', '第二段']) {
      const titleElement = [...host.querySelectorAll<HTMLElement>('span')].find(
        (el) => el.textContent === `${title}${suffix}` && !el.querySelector('span'),
      );
      if (!titleElement) throw new Error('Conversation title is missing');
      act(() => titleElement.focus());
      expect(document.querySelector('[role="tooltip"]')?.textContent ?? '').toContain(`${title}${suffix}`);
    }
  });
  it('unknown working cat IDs never reach text, accessible names, or image alt', () => {
    const unknown = 'private-runtime-id-unknown';
    act(() =>
      root.render(
        <ThreadRowSignals
          presence={{ status: 'working', cats: [unknown] }}
          unreadCount={0}
          hasUserMention={false}
          hasDraft={false}
        />,
      ),
    );
    expect(host.textContent).toContain('猫猫正在工作');
    expect(
      [...host.querySelectorAll('[alt], [aria-label], [title]')]
        .map((el) => `${el.getAttribute('alt')} ${el.getAttribute('aria-label')} ${el.getAttribute('title')}`)
        .join(' '),
    ).not.toContain(unknown);
  });
  it('unread caps only the visual count and idle rows with no signals disappear', () => {
    act(() =>
      root.render(<ThreadRowSignals presence={{ status: 'idle' }} unreadCount={120} hasUserMention hasDraft />),
    );
    expect(host.textContent).toContain('99+');
    act(() =>
      root.render(
        <ThreadRowSignals presence={{ status: 'idle' }} unreadCount={0} hasUserMention={false} hasDraft={false} />,
      ),
    );
    expect(host.textContent).toBe('');
  });
});
