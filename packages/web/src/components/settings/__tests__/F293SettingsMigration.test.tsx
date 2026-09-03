import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { SETTINGS_SECTIONS } from '../settings-nav-config';

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
}));

describe('F293 Settings migration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.push.mockReset();
    useChatStore.setState({
      currentThreadId: 'thread-a',
      workspaceMode: 'dev',
      teamWorkspaceSubject: null,
      workspaceOpenRequest: null,
      workspaceOpenRevision: 0,
      rightPanelMode: 'status',
      rightPanelOpen: false,
      presentationLock: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps structural routing semantics separate from the F208 source workflow', () => {
    expect(SETTINGS_SECTIONS.find((section) => section.id === 'members')?.label).toBe('成员与运行时');
    const source = SETTINGS_SECTIONS.find((section) => section.id === 'profiles');
    expect(source?.label).toBe('能力画像来源');
    expect(source?.description).toContain('不编辑实时路由状态或协作偏好');
  });

  it('opens Team only from an explicit Settings click', async () => {
    const { OpenTeamWorkspaceButton } = await import('../OpenTeamWorkspaceButton');
    await act(async () => root.render(<OpenTeamWorkspaceButton />));
    expect(useChatStore.getState().workspaceMode).toBe('dev');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="settings-open-team"]')?.click());

    expect(useChatStore.getState()).toMatchObject({
      workspaceMode: 'team',
      teamWorkspaceSubject: null,
      rightPanelMode: 'workspace',
      rightPanelOpen: true,
    });
    expect(mocks.push).toHaveBeenCalledWith('/thread/thread-a');
  });
});
