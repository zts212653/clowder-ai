import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidebarPresence } from '@/stores/sidebarProjectionStore';

const cats = vi.hoisted(() =>
  Array.from({ length: 12 }, (_, i) => ({
    id: `known-${i}`,
    displayName: `伙伴${i + 1}`,
    nickname: `小名${i + 1}`,
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

import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { ThreadItem } from '../ThreadItem';
import { ThreadRowSignals } from '../ThreadRowSignals';

describe('F322 v2 row facts and recoverable names', () => {
  let host: HTMLDivElement;
  let root: Root;
  const title = '同一个很长很长的中文项目标题：'.repeat(8);
  const onSelect = vi.fn();
  const onPin = vi.fn();
  function renderItem(
    presence: SidebarPresence = { status: 'idle' },
    participants = cats.map((cat) => cat.id),
    isActive = false,
    rowTitle = `${title}第一段`,
    lastActiveAt = Date.now() - 60_000,
  ) {
    act(() =>
      root.render(
        <ThreadItem
          id="conversation"
          title={rowTitle}
          participants={participants}
          lastActiveAt={lastActiveAt}
          isActive={isActive}
          onSelect={onSelect}
          onTogglePin={onPin}
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
    writeShellLanguage('zh');
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
    writeShellLanguage('zh');
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    [30_000, '刚刚', 'just now'],
    [60_000, '1分', '1 min'],
    [240_000, '4分', '4 min'],
    [3_600_000, '1时', '1 h'],
    [86_400_000, '1天', '1 d'],
  ])('uses current v2 language for title time after %i ms, keeping classic Chinese', (elapsed, zh, en) => {
    vi.spyOn(Date, 'now').mockReturnValue(10 * 86_400_000);
    renderItem({ status: 'idle' }, [], false, 'A conversation', Date.now() - Number(elapsed));
    const time = () => host.querySelector('[data-testid="thread-row-time"]')?.textContent;
    expect(time()).toBe(zh);
    act(() => writeShellLanguage('en'));
    expect(time()).toBe(en);
    act(() => writeShellPresentation('classic'));
    expect(host.querySelector('[data-testid="thread-row-time"]')).toBeNull();
    expect(host.querySelector('[title*="A conversation"]')?.getAttribute('title')).toMatch(/刚刚|前/);
    act(() => writeShellPresentation('v2'));
    expect(time()).toBe(en);
  });
  it.each(['error', 'working', 'done'] as const)('%s coexists with mention, unread, and draft', (status) => {
    renderItem({ status, cats: cats.map((cat) => cat.id), activeSince: Date.now() - 120_000 });
    expect(host.querySelector(`[data-testid="thread-row-${status}"]`)).not.toBeNull();
    expect(host.querySelector('[data-testid="thread-row-mention"]')?.textContent).toBe('@你');
    expect(host.querySelector('[data-testid="thread-row-unread"]')?.textContent).toContain('5');
    expect(host.querySelector('[data-testid="thread-row-draft"]')?.textContent).toBe('草稿');
    if (status === 'working') {
      expect(host.textContent).toContain('执行中 · 2 分');
      expect(host.textContent).toContain('ᓚᘏᗢ');
      expect(host.textContent).not.toContain('伙伴1 正在工作');
    }
    act(() => host.querySelector<HTMLElement>('[data-thread-id]')?.click());
    expect(onSelect).toHaveBeenCalledWith('conversation');
  });
  it('shows the current conversation draft in v2 while classic retains its inactive-only decoration', () => {
    renderItem({ status: 'idle' }, [], true);
    expect(host.querySelector('[data-testid="thread-row-draft"]')?.textContent).toBe('草稿');
    act(() => writeShellPresentation('classic'));
    expect(host.textContent).not.toContain('[草稿]');
    renderItem({ status: 'idle' }, [], false);
    expect(host.textContent).toContain('[草稿]');
  });
  it('clipped title recovery contains the title without a row metadata card', () => {
    renderItem();
    const titleElement = [...host.querySelectorAll<HTMLElement>('span')].find(
      (el) => el.textContent === `${title}第一段` && !el.querySelector('span'),
    );
    if (!titleElement) throw new Error('Conversation title is missing');
    Object.defineProperties(titleElement, { clientHeight: { value: 40 }, scrollHeight: { value: 80 } });
    act(() => titleElement.focus());
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip, 'keyboard focus must reveal the full roster').not.toBeNull();
    expect(tip?.textContent).toBe(`${title}第一段`);
    expect(tip?.getAttribute('data-side')).toBe('right');
    expect(tip?.textContent).not.toContain('参与');
  });
  it('fully visible titles do not create a hover card and classic keeps its native row details', () => {
    renderItem({ status: 'idle' }, [], false, '首席唤醒官');
    const rowTitle = host.querySelector<HTMLElement>('[role="link"]')!;
    act(() => rowTitle.focus());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => writeShellPresentation('classic'));
    expect(host.querySelector('[title*="首席唤醒官"]')?.getAttribute('title')).toContain('首席唤醒官');
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
      Object.defineProperties(titleElement, { clientHeight: { value: 40 }, scrollHeight: { value: 80 } });
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
    expect(host.textContent).toContain('执行中');
    expect(
      [...host.querySelectorAll('[alt], [aria-label], [title]')]
        .map((el) => `${el.getAttribute('alt')} ${el.getAttribute('aria-label')} ${el.getAttribute('title')}`)
        .join(' '),
    ).not.toContain(unknown);
  });
  it('uses only deduplicated working cats with persona rings and keyboard name recovery', () => {
    renderItem({ status: 'working', cats: ['known-1', 'known-1', 'known-3'], activeSince: Date.now() - 21 * 60_000 });
    const status = host.querySelector('[data-testid="thread-row-working"]');
    expect([...(status?.querySelectorAll('img') ?? [])].map((img) => img.alt)).toEqual(['伙伴2', '伙伴4']);
    expect(status?.querySelectorAll('.ring-2')).toHaveLength(2);
    expect(status?.textContent).toContain('执行中 · 21 分');
    expect(status?.textContent).toContain('小名2+1');
    expect(status?.querySelector('[data-testid="thread-running-cat"]')?.getAttribute('style')).toContain(
      '--semantic-info',
    );
    const cat = status?.querySelector<HTMLElement>('[data-testid="thread-signal-cats"]');
    expect(cat).not.toBeNull();
    act(() => cat?.focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('伙伴2');
    expect(status?.querySelector('[data-testid="thread-running-cat"]')?.className).toContain(
      'motion-reduce:animate-none',
    );
  });
  it('shows the successful cat avatar for replied without a running animation', () => {
    renderItem({ status: 'done', cats: ['known-3'] });
    const status = host.querySelector('[data-testid="thread-row-done"]');
    expect(status?.querySelector('img')?.alt).toBe('伙伴4');
    expect(status?.textContent).toContain('小名4');
    expect(status?.querySelector('[data-testid="thread-replied-check"]')).not.toBeNull();
    expect(status?.querySelector('[data-testid="thread-replied-cat"]')?.getAttribute('style')).toContain(
      '--semantic-success',
    );
    expect(status?.querySelector('[data-testid="thread-replied-cat"]')?.className).not.toContain('animate');
    expect(status?.querySelector('[data-testid="thread-running-cat"]')).toBeNull();
  });
  it('r2 summarizes twelve working cats with two avatars, one call name and a recoverable +11 roster', () => {
    renderItem({ status: 'working', cats: cats.map((cat) => cat.id), activeSince: Date.now() - 120_000 });
    const roster = host.querySelector<HTMLElement>('[data-testid="thread-signal-cats"]')!;
    expect(roster.querySelectorAll('img')).toHaveLength(2);
    expect(roster.textContent).toBe('小名1+11');
    act(() => roster.focus());
    for (const cat of cats) expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(cat.displayName);
  });
  it.each([
    ['working', 'info'],
    ['done', 'success'],
    ['error', 'critical'],
  ] as const)('r2 gives %s words their theme status ink', (status, role) => {
    renderItem({ status, cats: ['known-0'] });
    const text = host.querySelector<HTMLElement>('[data-testid="thread-status-text"]');
    expect(text?.getAttribute('style')).toContain(`--semantic-${role}`);
    expect(text?.getAttribute('style')).toContain('--shell-ink');
    expect(text?.className).toContain('font-medium');
  });
  it.each([
    [59, '59 分'],
    [60, '1 小时'],
    [2879, '47 小时'],
    [2880, '2 天'],
    [3471, '2 天'],
  ])('uses readable elapsed units for %i minutes', (minutes, expected) => {
    renderItem({ status: 'working', cats: ['known-0'], activeSince: Date.now() - Number(minutes) * 60_000 });
    expect(host.querySelector('[data-testid="thread-working-duration"]')?.textContent).toBe(` · ${expected}`);
  });
  it.each([
    'zh',
    'en',
  ] as const)('calls sub-minute executions just started in %s, without guessing unknown timing', (language) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_791_589_000_000);
    act(() => writeShellLanguage(language));
    for (const elapsed of [0, 59_999, -1_000]) {
      renderItem({ status: 'working', cats: ['known-0'], activeSince: Date.now() - elapsed });
      expect(host.querySelector('[data-testid="thread-working-duration"]')?.textContent).toBe(
        language === 'zh' ? ' · 刚开始' : ' · just now',
      );
    }
    renderItem({ status: 'working', cats: ['known-0'], activeSince: Date.now() - 60_000 });
    expect(host.querySelector('[data-testid="thread-working-duration"]')?.textContent).toBe(
      language === 'zh' ? ' · 1 分' : ' · 1 min',
    );
    renderItem({ status: 'working', cats: ['known-0'] });
    expect(host.querySelector('[data-testid="thread-working-duration"]')).toBeNull();
  });
  it('localizes hour and day units without inventing an unknown start time', () => {
    act(() => writeShellLanguage('en'));
    renderItem({ status: 'working', cats: ['known-0'], activeSince: Date.now() - 90 * 60_000 });
    expect(host.querySelector('[data-testid="thread-working-duration"]')?.textContent).toBe(' · 1 h');
    renderItem({ status: 'working', cats: ['known-0'], activeSince: Date.now() - 3471 * 60_000 });
    expect(host.querySelector('[data-testid="thread-working-duration"]')?.textContent).toBe(' · 2 d');
    renderItem({ status: 'working', cats: ['known-0'] });
    expect(host.querySelector('[data-testid="thread-working-duration"]')).toBeNull();
  });
  it('uses the short call name and recovers the full nickname by keyboard focus', () => {
    const originalNickname = cats[0].nickname;
    cats[0].nickname = '小太阳·砚砚';
    try {
      renderItem({ status: 'working', cats: ['known-0'] });
      const status = host.querySelector('[data-testid="thread-row-working"]');
      expect(status?.textContent).toContain('小太阳');
      expect(status?.textContent).not.toContain('小太阳·砚砚');
      act(() => status?.querySelector<HTMLElement>('[data-testid="thread-signal-cats"]')?.focus());
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('小太阳·砚砚');
    } finally {
      cats[0].nickname = originalNickname;
    }
  });
  it('keeps the v2 menu pin command alongside the direct pin shortcut', () => {
    renderItem();
    expect(host.querySelector('[data-testid="thread-pin-button"]')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')?.click());
    expect(host.querySelector('[role="menu"]')?.textContent).toContain('置顶');
    act(() =>
      [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((button) => button.textContent === '置顶')
        ?.click(),
    );
    expect(onPin).toHaveBeenCalledWith('conversation', true);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('switches status words to English while retaining the same facts and overflow identities', () => {
    act(() => writeShellLanguage('en'));
    renderItem({ status: 'working', cats: cats.map((cat) => cat.id), activeSince: Date.now() - 180_000 });
    expect(host.textContent).toContain('Running · 3 min');
    expect(host.textContent).toContain('Draft');
    expect(host.textContent).toContain('@you');
    expect(host.textContent).toContain('小名1+11');
    expect(host.querySelectorAll('[data-testid="thread-signal-cats"] img')).toHaveLength(2);
    act(() => host.querySelector<HTMLElement>('[data-testid="thread-signal-cats"]')?.focus());
    for (const cat of cats) expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(cat.nickname);
  });
  it('keeps execution duration independent of the recoverable status label in the densest row', () => {
    act(() => writeShellLanguage('en'));
    act(() =>
      root.render(
        <ThreadRowSignals
          presence={{ status: 'working', cats: cats.map((cat) => cat.id), activeSince: Date.now() - 7 * 60_000 }}
          unreadCount={120}
          hasUserMention
          hasDraft
        />,
      ),
    );
    const status = host.querySelector<HTMLElement>('[data-testid="thread-working-label"]');
    const duration = host.querySelector<HTMLElement>('[data-testid="thread-working-duration"]');
    expect(status?.textContent).toBe('Running');
    expect(duration?.textContent).toBe(' · 7 min');
    expect(status?.contains(duration)).toBe(false);
    const recoverable = host.querySelector<HTMLElement>('[data-testid="thread-status-text"]')!;
    Object.defineProperties(recoverable, { clientWidth: { value: 20 }, scrollWidth: { value: 80 } });
    act(() => recoverable.focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Running · 7 min');
    expect(host.querySelector('[data-testid="thread-row-draft"]')?.textContent).toBe('Draft');
    expect(host.querySelector('[data-testid="thread-row-mention"]')?.textContent).toBe('@you');
    expect(host.querySelector('[data-testid="thread-row-unread"]')?.textContent).toContain('99+');
    expect(host.textContent).toContain('小名1+11');
  });
  it('unread caps only the visual count and idle rows with no signals disappear', () => {
    act(() =>
      root.render(<ThreadRowSignals presence={{ status: 'idle' }} unreadCount={120} hasUserMention hasDraft />),
    );
    expect(host.textContent).toContain('99+');
    expect(host.querySelector('[data-testid="thread-row-mention"]')?.getAttribute('style')).toContain(
      '--shell-primary-on',
    );
    expect(host.querySelector('[data-testid="thread-row-unread"]')?.getAttribute('style')).toContain(
      '--shell-primary-soft',
    );
    act(() =>
      root.render(
        <ThreadRowSignals presence={{ status: 'idle' }} unreadCount={0} hasUserMention={false} hasDraft={false} />,
      ),
    );
    expect(host.textContent).toBe('');
  });
});
