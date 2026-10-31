import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { AttentionClusterHeader } from '../AttentionCluster';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: (id: string) => ({ id, displayName: id, color: { primary: '#777777' } }) }),
}));
const members = [0, 1, 2].map((index) => ({
  id: `member-${index}`,
  title: `Member ${index}`,
  projectPath: '/project',
  createdBy: 'user',
  participants: ['idle-cat'],
  createdAt: 0,
  lastActiveAt: 0,
  pinned: true,
  favorited: false,
  preferredCats: [],
  labels: [],
  systemKind: null,
  isHubThread: false,
  unreadCount: index + 1,
  hasUserMention: index < 2,
  presence:
    index < 2
      ? { status: 'working', cats: index === 0 ? ['working-a', 'working-b'] : ['working-a'] }
      : { status: 'done', cats: ['replied-cat'] },
})) as SidebarSnapshotRow[];
const cluster = {
  anchor: 'group:g',
  rootThreadId: 'member-0',
  groupId: 'g',
  title: 'Our group',
  memberIds: members.map((m) => m.id),
  searchText: '',
};

describe('F322 v2 group header preserves F277 actions', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onToggle = vi.fn(),
    onRename = vi.fn(),
    onAdd = vi.fn(),
    onMemberSort = vi.fn(),
    onResetMemberSort = vi.fn();
  function render(expanded = false, currentMembers: SidebarSnapshotRow[] = members) {
    act(() =>
      root.render(
        <AttentionClusterHeader
          cluster={cluster}
          members={currentMembers}
          displayTitle="Our group"
          expanded={expanded}
          onToggle={onToggle}
          onRename={onRename}
          onAdd={onAdd}
          onMemberSort={onMemberSort}
          onResetMemberSort={onResetMemberSort}
        />,
      ),
    );
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeShellPresentation('v2');
    writeShellLanguage('zh');
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    writeShellLanguage('zh');
    vi.restoreAllMocks();
  });
  function click(text: string) {
    const button = [...host.querySelectorAll('button')].find(
      (el) => el.textContent === text || el.getAttribute('aria-label') === text,
    );
    expect(button, text).toBeDefined();
    act(() => button?.click());
  }
  it('keeps working cats and one attention count without duplicate collapsed badges', () => {
    render();
    expect([...host.querySelectorAll('img')].map((img) => img.alt)).toEqual(['working-a', 'working-b']);
    expect(host.querySelector('[data-testid="group-mention"]')).toBeNull();
    expect(host.querySelector('[data-testid="group-unread"]')).toBeNull();
    expect(host.querySelector('[data-testid="group-count"]')?.textContent).toBe('3 条要看');
    expect(host.querySelector('[title]')).toBeNull();
    expect(host.textContent).not.toContain('个置顶');
    expect(host.querySelector('select')).toBeNull();
    expect(host.querySelector('[data-testid="group-header-v2"]')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click());
    expect(onToggle).toHaveBeenCalledOnce();
    render(true);
    expect(host.querySelector('[data-testid="group-count"]')?.textContent).toBe('3');
    expect(host.querySelector('[data-testid="group-count"]')?.getAttribute('aria-label')).toBe('3 个对话');
  });
  it('retains add, rename, reset and sorting behind the more menu without toggling the group', () => {
    render();
    click('更多操作');
    click('添加对话');
    expect(onAdd).toHaveBeenCalledOnce();
    click('更多操作');
    click('运行优先');
    expect(onMemberSort).toHaveBeenCalledWith('running-first');
    click('更多操作');
    click('重命名');
    expect(host.querySelector('input[aria-label="对话组名称"]')).not.toBeNull();
    click('恢复名称');
    expect(onRename).toHaveBeenCalledWith(null);
    expect(onToggle).not.toHaveBeenCalled();
  });
  it('reports recent as the unset v2 default and offers a reset without writing a new persistent mode', () => {
    render();
    click('更多操作');
    const selected = host.querySelector('[role="menuitemradio"][aria-checked="true"]');
    expect(selected?.textContent).toBe('最近活跃（默认）');
    click('手动顺序');
    expect(onMemberSort).toHaveBeenCalledWith('manual');
    click('更多操作');
    click('最近活跃（默认）');
    expect(onResetMemberSort).toHaveBeenCalledOnce();
    expect(onMemberSort).toHaveBeenCalledTimes(1);
  });
  it('marks the Group before its name, puts the chevron after it and never derives a Group pin from members', () => {
    render();
    const title = host.querySelector('[data-testid="group-title-line"]');
    const summary = host.querySelector('[data-testid="group-status-line"]');
    expect(title?.textContent).toContain('Our group');
    expect(title?.querySelector('[data-testid="group-pinned"]')).toBeNull();
    const slot = title?.querySelector('[data-sidebar-pin-slot]');
    expect(slot).not.toBeNull();
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    expect(title?.firstElementChild).toBe(slot);
    expect(slot?.querySelector('[data-testid="group-folder-icon"]')).not.toBeNull();
    expect(slot?.querySelector('button, [data-testid="group-pinned"]')).toBeNull();
    const toggle = title?.querySelector('button[aria-controls]');
    expect(toggle?.firstElementChild?.textContent).toBe('Our group');
    expect(toggle?.lastElementChild?.getAttribute('data-testid')).toBe('group-chevron');
    expect(summary?.textContent).toContain('2 只在干活');
    expect(summary?.querySelector('[data-testid="group-mention"]')).toBeNull();
    expect(summary?.querySelector('[data-testid="group-unread"]')).toBeNull();
    expect(summary?.querySelector('[data-testid="group-working-label"]')?.getAttribute('style')).toContain(
      '--semantic-info',
    );
    expect(summary?.textContent).not.toContain('idle-cat');
  });
  it('offers keyboard sorting and restores focus after Escape in both languages', () => {
    act(() => writeShellLanguage('en'));
    render();
    click('More actions');
    const menu = host.querySelector<HTMLElement>('[role="menu"]');
    expect(document.activeElement?.textContent).toBe('Add conversations');
    act(() => menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(document.activeElement?.textContent).toBe('Running first');
    act(() => menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('More actions');
  });
  it('uses English group recovery copy while keeping native classic tips frozen', () => {
    writeShellLanguage('en');
    render(true);
    expect(host.querySelector('[data-testid="group-count"]')?.getAttribute('aria-label')).toBe('3 conversations');
    expect(host.querySelector('[title]')).toBeNull();
    click('More actions');
    expect(host.querySelector('[role="menu"]')?.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    act(() => writeShellPresentation('classic'));
    expect(host.querySelector('select')?.getAttribute('title')).toBe(
      '运行优先在展开时排序；展开期间位置保持稳定。拖动整理时显示手动顺序。',
    );
    expect(host.querySelector('button[title="修改私人显示名"]')).not.toBeNull();
  });
  it.each(['zh', 'en'] as const)('labels conversations needing attention once in %s', (language) => {
    act(() => writeShellLanguage(language));
    render();
    const badge = host.querySelector('[data-testid="group-count"]');
    expect(badge?.textContent).toBe(language === 'zh' ? '3 条要看' : '3 to see');
    expect(badge?.querySelector('.sr-only')).toBeNull();
    expect(badge?.getAttribute('aria-label')).toBe(language === 'zh' ? '3 条要看' : '3 to see');
    expect(host.querySelector('[data-testid="group-mention"]')).toBeNull();
  });
  it.each(['zh', 'en'] as const)('summarizes error before replied from member presence in %s', (language) => {
    act(() => writeShellLanguage(language));
    const rows = members.map((member, index) => ({
      ...member,
      presence: { status: index === 0 ? 'error' : 'done' },
    })) as SidebarSnapshotRow[];
    render(false, rows);
    const summary = host.querySelector<HTMLElement>('[data-testid="group-presence-summary"]');
    expect(summary?.textContent).toBe(language === 'zh' ? '1 个出错' : '1 error');
    // A collapsed Group must identify the failing conversation; its parent can have a successful reply.
    expect(summary?.querySelector('[data-testid="thread-status-text"]')?.getAttribute('aria-label')).toContain(
      'Member 0',
    );
    expect(summary?.querySelector('[data-testid="thread-status-text"]')?.getAttribute('aria-label')).not.toContain(
      'Member 1',
    );
    expect(summary?.querySelector('[data-testid="group-error-dot"]')?.getAttribute('style')).toContain(
      '--semantic-critical',
    );
    expect(summary?.querySelector('[data-testid="thread-status-text"]')?.getAttribute('style')).toContain(
      '--semantic-critical',
    );
    expect(host.querySelector('[data-testid="group-replied-cat"]')).toBeNull();
    expect(host.querySelector('[data-testid="group-mention"]')).toBeNull();
    expect(host.querySelector('[data-testid="group-unread"]')).toBeNull();
    expect(host.querySelector('[data-testid="group-status-line"]')?.className).toContain('whitespace-nowrap');
    render(true, rows);
    expect(host.querySelector('[data-testid="group-status-line"]')).toBeNull();
  });
  it.each([
    'zh',
    'en',
  ] as const)('counts replied conversations, not cats, with a static green cat and check in %s', (language) => {
    act(() => writeShellLanguage(language));
    const rows = members.map((member, index) => ({
      ...member,
      presence: index < 2 ? { status: 'done', cats: ['same-cat', 'second-cat'] } : { status: 'idle' },
    })) as SidebarSnapshotRow[];
    render(false, rows);
    const summary = host.querySelector('[data-testid="group-presence-summary"]');
    expect(summary?.textContent).toContain(language === 'zh' ? '2 个已回复' : '2 replied');
    const cat = summary?.querySelector('[data-testid="group-replied-cat"]');
    expect(cat?.getAttribute('style')).toContain('--semantic-success');
    expect(cat?.className).not.toContain('animate');
    expect(summary?.querySelector('[data-testid="group-replied-check"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="group-error-dot"]')).toBeNull();
    expect(summary?.querySelector('img')).toBeNull(); // No unrelated participant roster.
  });
  it('does not invent awaiting/done states from unread or mention signals on idle members', () => {
    render(
      false,
      members.map((member) => ({ ...member, presence: { status: 'idle' } })),
    );
    expect(host.querySelector('[data-testid="group-presence-summary"]')).toBeNull();
    expect(host.querySelector('[data-testid="group-working-label"]')).toBeNull();
    expect(host.querySelector('[data-testid="group-status-line"] [data-signal-presence]')).toBeNull();
    expect(host.querySelector('[data-testid="group-unread"]')).toBeNull();
    expect(host.querySelector('[data-testid="group-mention"]')).toBeNull();
  });
  it('keeps working presence ahead of terminal summaries even without known cat IDs', () => {
    const rows = members.map((member, index) => ({
      ...member,
      presence: { status: index === 0 ? 'working' : 'error' },
    })) as SidebarSnapshotRow[];
    render(false, rows);
    expect(host.querySelector('[data-testid="group-working-label"]')?.textContent).toBe('执行中');
    expect(host.querySelector('[data-testid="group-running-cat"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="group-error-dot"]')).toBeNull();
    expect(host.querySelector('[data-testid="group-working-label"]')?.textContent).not.toContain('0');
  });
  it('keeps classic group controls and summaries unchanged', () => {
    writeShellPresentation('classic');
    render();
    expect(host.textContent).toContain('3 个置顶');
    expect(host.textContent).toContain('进行中 2');
    expect(host.querySelector('select')).not.toBeNull();
    expect(host.querySelector('button[title="修改私人显示名"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="group-header-v2"]')).toBeNull();
  });
});
