import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { SearchGroupOrganizer } from '../SearchGroupOrganizer';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellPresentation('v2');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  writeShellPresentation('classic');
  vi.unstubAllGlobals();
});
it('preselects the matching group, counts members already there, and saves only the other matches', async () => {
  const groups = [
    { id: 'attention_other', name: 'F330 发版', threadIds: ['thread_x', 'thread_y'] },
    { id: 'attention_planet', name: 'F329「猫猫星球」游戏', threadIds: ['thread_a', 'thread_b'] },
  ];
  const threads = ['a', 'b', 'c'].map((id) => ({
    id: `thread_${id}`,
    title: `F329 ${id}`,
    lastActiveAt: 1,
    projectPath: '/project',
    participants: [],
    pinned: true,
    favorited: false,
    labels: [],
    preferredCats: [],
    systemKind: null,
    isHubThread: false,
    unreadCount: 0,
    hasUserMention: false,
    presence: { status: 'idle' as const },
  })) satisfies SidebarSnapshotRow[];
  const onCommand = vi.fn().mockResolvedValue({ ok: false, error: 'offline', conflict: false });
  await act(async () =>
    root.render(
      <SearchGroupOrganizer
        request={{ query: 'F329' }}
        threads={threads}
        groups={groups}
        renderThread={(thread) => <span>{thread.title}</span>}
        onCommand={onCommand}
        onReload={vi.fn()}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  const editor = document.querySelector('[data-testid="search-group-editor"]')!;
  expect(editor.textContent).toContain('匹配 3 条 · 其中 2 条已在');
  expect(editor.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('F329');
  expect(editor.querySelector('input[aria-label="搜组名"]')).not.toBeNull();
  const save = editor.querySelector<HTMLButtonElement>('[data-testid="search-group-save"]')!;
  expect(save.textContent).toContain('把另外 1 条加入 F329');
  await act(async () => save.click());
  expect(onCommand).toHaveBeenCalledWith(
    expect.objectContaining({ groupId: 'attention_planet', threadIds: ['thread_c'] }),
  );
  expect(editor.querySelector('[role="alert"]')?.textContent).toContain('offline');
});
