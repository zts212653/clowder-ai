import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManagerContent } from '../plugin-manager/PluginManagerContent';
import {
  PLUGIN_MANAGER_DESIGN_FIXTURES,
  type PluginManagerDesignFixture,
} from '../plugin-manager/plugin-manager-fixtures';

const ready: PluginManagerDesignFixture = {
  ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
  configFields: [],
  steps: [],
  setupSteps: [],
  trust: 'official',
};
const update: PluginManagerDesignFixture = {
  ...ready,
  id: 'update',
  displayName: 'Update plugin',
  availableVersion: '2.0.0',
  actions: { install: true, repair: false, setEnabled: true, uninstall: true, blockingReasons: [] },
};
const broken: PluginManagerDesignFixture = {
  ...update,
  id: 'broken',
  displayName: 'Broken plugin',
  live: 'crashed',
  trust: 'unknown',
  diagnostic: 'UNEXPECTED_RUNTIME_FAILURE',
  actions: { ...update.actions!, repair: true },
};
const available: PluginManagerDesignFixture = {
  ...ready,
  id: 'available',
  displayName: 'Available plugin',
  source: 'catalog',
  artifact: 'absent',
  installedVersion: null,
  intent: 'disabled',
  live: 'stopped',
};

describe('accepted plugin north star', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('groups each plugin once, including updates and every installable source, with counts', () => {
    act(() =>
      root.render(
        <PluginManagerContent
          presentation="v2"
          fixtures={[ready, available, update, broken, { ...available, id: 'local-candidate', source: 'local' }]}
        />,
      ),
    );
    const groups = [...container.querySelectorAll('[data-plugin-section]')];
    expect(groups.map((node) => node.getAttribute('data-plugin-section'))).toEqual([
      'attention',
      'installed',
      'available',
    ]);
    expect(groups.map((node) => node.querySelector('h3')?.textContent)).toEqual([
      '需要处理 · 2',
      '已安装 · 1',
      '可以安装 · 2',
    ]);
    expect(container.querySelectorAll('[data-plugin-list-row]')).toHaveLength(5);
    expect(groups[0]?.querySelector('[data-plugin-id="update"]')).not.toBeNull();
    expect(groups[2]?.querySelector('[data-plugin-id="local-candidate"]')).not.toBeNull();
  });

  it('uses only status, update or description for the one summary line', () => {
    act(() => root.render(<PluginManagerContent presentation="v2" fixtures={[broken, update, ready]} />));
    const row = (id: string) => container.querySelector(`[data-plugin-id="${id}"]`)!;
    expect(row('broken').querySelector('[data-plugin-summary]')?.textContent).toBe('运行出错');
    expect(row('broken').querySelector('[data-plugin-source-trust]')?.textContent).toBe('来源未知');
    expect(row('update').querySelector('[data-plugin-summary]')?.textContent).toBe('有新版 2.0.0');
    expect(row(ready.id).querySelector('[data-plugin-summary]')?.textContent).toContain('跟踪 PR');
    expect(row(ready.id).querySelector('[data-plugin-source-trust]')).toBeNull();
    for (const element of [row('broken'), row('update'), row(ready.id)]) {
      expect(element.querySelectorAll('[data-plugin-summary]')).toHaveLength(1);
    }
  });

  it('separates repair and update, and retains uninstall only at the detail footer', () => {
    const onRepair = vi.fn(),
      onInstall = vi.fn(),
      onUninstall = vi.fn();
    act(() =>
      root.render(
        <PluginManagerContent
          presentation="v2"
          fixtures={[broken]}
          onRepair={onRepair}
          onInstall={onInstall}
          onUninstall={onUninstall}
        />,
      ),
    );
    const detail = container.querySelector('[data-testid="plugin-manager-detail"]')!;
    const error = detail.querySelector('[data-plugin-detail-section="attention"]')!;
    const newer = detail.querySelector('[data-plugin-detail-section="update"]')!;
    const repair = error.querySelector<HTMLButtonElement>('[data-plugin-detail-action="repair"]');
    const upgrade = newer.querySelector<HTMLButtonElement>('[data-plugin-detail-action="update"]');
    expect(repair?.classList.contains('console-button-primary')).toBe(true);
    expect(upgrade?.classList.contains('console-button-primary')).toBe(false);
    expect(upgrade?.textContent).toBe('更新到 2.0.0');
    expect(detail.querySelectorAll('.console-button-primary')).toHaveLength(1);
    expect(error.querySelector('details')?.open).toBe(false);
    expect(error.querySelector('summary')?.textContent).toBe('技术详情');
    const footer = detail.querySelector('[data-plugin-detail-section="provenance"]')!;
    const uninstall = footer.querySelector<HTMLButtonElement>('[data-plugin-uninstall]');
    expect(container.querySelector('[data-plugin-list-row] [data-plugin-uninstall]')).toBeNull();
    act(() => {
      repair?.click();
      upgrade?.click();
      uninstall?.click();
    });
    expect(onRepair).toHaveBeenCalledWith('broken');
    expect(onInstall).toHaveBeenCalledWith('broken');
    expect(onUninstall).toHaveBeenCalledWith('broken');
  });

  it('does not offer an update or destructive action the Host has blocked', () => {
    act(() =>
      root.render(
        <PluginManagerContent
          presentation="v2"
          fixtures={[
            {
              ...broken,
              actions: {
                install: false,
                repair: true,
                setEnabled: false,
                uninstall: false,
                blockingReasons: ['policy'],
              },
            },
          ]}
          onInstall={vi.fn()}
          onRepair={vi.fn()}
          onUninstall={vi.fn()}
        />,
      ),
    );
    const detail = container.querySelector('[data-testid="plugin-manager-detail"]')!;
    expect(detail.querySelector('[data-plugin-detail-action="update"]')).toBeNull();
    expect(detail.querySelector('[data-plugin-uninstall]')).toBeNull();
  });

  it('uses English group and version copy on the same production path', () => {
    act(() => root.render(<PluginManagerContent presentation="v2" locale="en" fixtures={[update, available]} />));
    expect(container.querySelector('[data-plugin-section="attention"] h3')?.textContent).toBe('Needs attention · 1');
    expect(container.querySelector('[data-plugin-section="available"] h3')?.textContent).toBe(
      'Available to install · 1',
    );
    expect(container.querySelector('[data-plugin-summary]')?.textContent).toBe('New version 2.0.0');
  });
});
