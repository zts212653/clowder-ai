import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('@/components/settings/SettingsContent', () => ({
  SettingsContent: ({ section }: { section: string }) => <section data-testid="owner-content">{section}</section>,
}));
vi.mock('@/components/settings/ThemeSettingsPanel', () => ({ ThemeSettingsPanel: () => null }));
vi.mock('../use-open-destination', () => ({ useOpenDestination: () => ({ openEntry: vi.fn(), openTeam: vi.fn() }) }));
vi.mock('@/hooks/usePinnedSections', () => ({
  usePinnedSections: () => ({ isPinned: () => false, pin: vi.fn(), unpin: vi.fn() }),
}));
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({ name: 'You', avatar: '/uploads/avatar-operator.png' }),
}));

import { OpenTeamWorkspaceButton } from '@/components/settings/OpenTeamWorkspaceButton';
import { SettingsShellV2 } from '@/components/settings/SettingsShellV2';

function SettingsProof() {
  const [selection, onSelect] = useState('members');
  return <SettingsShellV2 selection={selection} onSelect={onSelect} fixedLayout={false} />;
}
describe('F322 settings secondary navigation contracts', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    push.mockClear();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<SettingsProof />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it('Right Arrow reaches the next settings tab', () => {
    const current = host.querySelector<HTMLElement>('[data-testid="settings-tab-members"]');
    const next = host.querySelector<HTMLElement>('[data-testid="settings-tab-accounts"]');
    if (!current || !next) throw new Error('Settings tabs are missing');
    act(() => {
      current.focus();
      current.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(next);
  });
  it('the selected settings section has a named associated tabpanel', () => {
    const tab = host.querySelector('[role="tab"][aria-selected="true"]');
    const panel = host.querySelector('[role="tabpanel"]');
    expect(panel).not.toBeNull();
    expect(tab?.getAttribute('aria-controls')).toBe(panel?.id);
    expect(panel?.getAttribute('aria-labelledby')).toBe(tab?.id);
  });
  it('opens the canonical Team destination from the current Workspace entry', async () => {
    useChatStore.setState({ currentThreadId: 'thread-team-entry', workspaceMode: 'dev' });
    act(() => root.render(<OpenTeamWorkspaceButton />));
    const entry = host.querySelector<HTMLButtonElement>('[data-testid="settings-open-team"]');
    expect(entry?.textContent).toBe('打开猫猫团队');
    await act(async () => entry?.click());
    expect(useChatStore.getState().workspaceMode).toBe('team');
    expect(useChatStore.getState().rightPanelMode).toBe('workspace');
    expect(push).toHaveBeenCalledWith('/thread/thread-team-entry');
  });
  it('opens the personal page from the first owner row, with the actual avatar and name', () => {
    const owner = host.querySelector<HTMLButtonElement>('[data-testid="settings-entry-you"]');
    expect(owner?.textContent).toContain('You');
    expect(owner?.querySelector('img')?.getAttribute('src')).toBe('/uploads/avatar-operator.png');
    act(() => owner?.click());
    expect(host.querySelector('[data-testid="owner-content"]')?.textContent).toBe('you');
    expect(host.querySelector('[data-testid="settings-entry-you"]')?.getAttribute('aria-current')).toBe('page');
  });
});
