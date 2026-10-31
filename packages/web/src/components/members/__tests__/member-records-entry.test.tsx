import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { model } from '../../routing-context/__tests__/team-panel-fixtures';
import { writeShellLanguage } from '../../shell/shell-language';
import { MemberCopyProvider } from '../editor-presentation';
import { MemberChanges } from '../MemberChangeMark';
import { MemberDetailHeader } from '../MemberDetailHeader';

const mocks = vi.hoisted(() => ({ push: vi.fn(), confirm: vi.fn(async () => false) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('../../useConfirm', () => ({ useConfirm: () => mocks.confirm }));
vi.mock('../../routing-context/useRoutingContext', () => ({
  useRoutingContext: () => ({ data: model, loading: false, error: null }),
}));

afterEach(() => {
  vi.clearAllMocks();
  writeShellLanguage('zh');
});
it('opens this member’s records, and preserves a dirty settings page when leaving is cancelled', async () => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writeShellLanguage('en');
  useChatStore.setState({ currentThreadId: 'records-thread', workspaceMode: 'dev', teamWorkspaceSubject: null });
  const container = document.createElement('div');
  const root = createRoot(container);
  const cat = { id: 'codex-sol' } as CatData;
  const render = (dirty: boolean) =>
    root.render(
      <MemberCopyProvider>
        <MemberChanges.Provider value={dirty ? [{ key: 'defaultModel', label: 'Model', fieldLabels: ['Model'] }] : []}>
          <MemberDetailHeader cat={cat} toggling={false} onToggle={vi.fn()} />
        </MemberChanges.Provider>
      </MemberCopyProvider>,
    );
  try {
    await act(async () => render(true));
    const link = container.querySelector<HTMLButtonElement>('[data-testid="member-open-records"]');
    expect(link?.textContent).toBe('View work records ›');
    expect(container.querySelectorAll('.member-history-row')).toHaveLength(0);
    await act(async () => link?.click());
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(useChatStore.getState().workspaceMode).toBe('dev');
    await act(async () => render(false));
    await act(async () => link?.click());
    expect(mocks.push).toHaveBeenCalledWith('/thread/records-thread');
    expect(useChatStore.getState()).toMatchObject({
      workspaceMode: 'team',
      teamWorkspaceSubject: { type: 'cat', id: cat.id },
    });
  } finally {
    act(() => root.unmount());
  }
});
