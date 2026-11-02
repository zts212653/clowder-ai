import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS_ENTRY_ID, findEntry } from '@/components/settings/settings-ia';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { WorkspaceToolsContent } from '../WorkspaceToolsContent';

vi.mock('next/navigation', () => ({
  usePathname: () => null,
  useRouter: () => {
    throw new Error('invariant: no Next router in the original external Workbench host');
  },
}));

describe('Workspace tools in the original external host', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    writeShellLanguage('zh');
    localStorage.removeItem('cat-cafe:pinned-settings-sections');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.removeItem('cat-cafe:pinned-settings-sections');
    vi.unstubAllGlobals();
  });
  const render = async (onOpenSettings = vi.fn(), onClose = vi.fn()) => {
    const callbacks = {
      onSelectDestination: vi.fn(),
      onSelectDevSurface: vi.fn(),
      recentSurfaces: [],
      onSelectRecentSurface: vi.fn(),
      onOpenSettings,
      onClose,
    };
    await act(async () => root.render(<WorkspaceToolsContent {...callbacks} />));
    return callbacks;
  };
  it('mounts the actual tool menu without requiring a Next router', async () => {
    await render();
    expect(host.querySelector('[data-testid="workspace-tools-content"]')).not.toBeNull();
  });
  it('hands the original Settings entry to the host before closing the menu', async () => {
    const order: string[] = [];
    const onOpenSettings = vi.fn(() => order.push('settings'));
    await render(
      onOpenSettings,
      vi.fn(() => order.push('close')),
    );
    const settings = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '设置与管理',
    );
    expect(settings).toBeDefined();
    await act(async () => settings?.click());
    expect(onOpenSettings).toHaveBeenCalledWith(findEntry(DEFAULT_SETTINGS_ENTRY_ID));
    expect(order).toEqual(['settings', 'close']);
  });

  it.each([
    ['schedule', '调度', 'mode', 'schedule'],
    ['evolution', '能力进化', 'workspace', 'capability-evolution'],
    ['eval', '评估', 'mode', 'eval'],
    ['community', '社区', 'mode', 'community'],
    ['team-workspace', '猫猫团队', 'mode', 'team'],
  ])('lets the existing %s shortcut be removed without opening a page or closing the tool menu', async (id, label, kind, destinationId) => {
    const pins = ['dest:schedule', 'dest:evolution', 'dest:eval', 'dest:community', 'dest:team-workspace'];
    localStorage.setItem('cat-cafe:pinned-settings-sections', JSON.stringify(pins));
    const callbacks = await render();
    const unpin = host.querySelector<HTMLButtonElement>(`button[aria-label="从窄栏取消固定「${label}」"]`);
    expect(unpin).not.toBeNull();
    await act(async () => unpin?.click());
    expect(JSON.parse(localStorage.getItem('cat-cafe:pinned-settings-sections') ?? '[]')).toEqual(
      pins.filter((pin) => pin !== `dest:${id}`),
    );
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(callbacks.onSelectDestination).not.toHaveBeenCalled();
    const open = host.querySelector<HTMLButtonElement>(`[data-workspace-destination="${kind}:${destinationId}"]`);
    expect(document.activeElement).toBe(open);
    await act(async () => root.render(null));
    const reentered = await render();
    expect(host.querySelector(`button[aria-label="从窄栏取消固定「${label}」"]`)).toBeNull();
    await act(async () =>
      host.querySelector<HTMLButtonElement>(`[data-workspace-destination="${kind}:${destinationId}"]`)?.click(),
    );
    expect(reentered.onSelectDestination).toHaveBeenCalledWith(expect.objectContaining({ kind, id: destinationId }));
    expect(reentered.onClose).toHaveBeenCalledOnce();
  });
});
