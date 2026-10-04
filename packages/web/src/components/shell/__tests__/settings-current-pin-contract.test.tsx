import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entryForSection } from '@/components/settings/settings-ia';
import { SETTINGS_SECTIONS } from '@/components/settings/settings-nav-config';

const pin = vi.hoisted(() => vi.fn());
vi.mock('@/components/settings/SettingsContent', () => ({
  SettingsContent: ({ section }: { section: string }) => <section data-testid="owner-content">{section}</section>,
}));
vi.mock('@/components/settings/ThemeSettingsPanel', () => ({ ThemeSettingsPanel: () => null }));
vi.mock('../use-open-destination', () => ({ useOpenDestination: () => ({ openEntry: vi.fn(), openTeam: vi.fn() }) }));
vi.mock('@/hooks/usePinnedSections', () => ({
  usePinnedSections: () => ({ isPinned: () => false, pin, unpin: vi.fn() }),
}));

import { SettingsShellV2 } from '@/components/settings/SettingsShellV2';

function SettingsProof() {
  const [selection, onSelect] = useState('members');
  return <SettingsShellV2 selection={selection} onSelect={onSelect} fixedLayout={false} />;
}
describe('F322 selected-section pins and manual tabs', () => {
  let host: HTMLDivElement;
  let root: Root;
  function control(id: string) {
    const element = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    if (!element) throw new Error(`Missing settings control ${id}`);
    return element;
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    pin.mockClear();
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
  it.each(
    SETTINGS_SECTIONS.map((section) => [section.id, section.label]),
  )('%s is pinnable after selecting it, despite one current-section pin control', (id, label) => {
    const owner = entryForSection(id);
    if (!owner) throw new Error('Missing section owner');
    act(() => control(`settings-entry-${owner.id}`).click());
    act(() => control(`settings-tab-${id}`).click());
    const toggle = host.querySelector<HTMLButtonElement>(`button[aria-label="固定「${label}」到侧栏"]`);
    if (!toggle) throw new Error(`Missing pin for ${id}`);
    act(() => toggle.click());
    expect(pin).toHaveBeenLastCalledWith(id);
  });
  it('manual activation moves focus without switching the loaded section', () => {
    const selected = control('settings-tab-members');
    act(() => {
      selected.focus();
      selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(document.activeElement).toBe(control('settings-tab-profiles'));
    expect(control('settings-tab-members').getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[data-testid="owner-content"]')?.textContent).toBe('members');
    act(() => control('settings-tab-profiles').click());
    expect(control('settings-tab-profiles').getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[data-testid="owner-content"]')?.textContent).toBe('profiles');
  });
});
