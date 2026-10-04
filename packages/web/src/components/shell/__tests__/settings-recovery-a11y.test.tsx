import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/settings/SettingsContent', () => ({
  SettingsContent: ({ section }: { section: string }) => <section data-testid="owner-content">{section}</section>,
}));
vi.mock('@/components/settings/ThemeSettingsPanel', () => ({ ThemeSettingsPanel: () => null }));
vi.mock('../use-open-destination', () => ({ useOpenDestination: () => ({ openEntry: vi.fn(), openTeam: vi.fn() }) }));
vi.mock('@/hooks/usePinnedSections', () => ({
  usePinnedSections: () => ({ isPinned: () => false, pin: vi.fn(), unpin: vi.fn() }),
}));

import { SettingsShellV2 } from '@/components/settings/SettingsShellV2';

function SettingsProof() {
  const [selection, onSelect] = useState('members');
  return <SettingsShellV2 selection={selection} onSelect={onSelect} fixedLayout={false} />;
}
describe('F322 settings secondary navigation contracts', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
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
    const next = host.querySelector<HTMLElement>('[data-testid="settings-tab-profiles"]');
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
  it('workspace-team secondary destination offers a pin action', () => {
    expect(host.querySelector('button[aria-label="固定「成员能力与路由状态」到侧栏"]')).not.toBeNull();
  });
});
