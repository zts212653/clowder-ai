import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManagerContent } from '../plugin-manager/PluginManagerContent';
import {
  PLUGIN_MANAGER_DESIGN_FIXTURES,
  type PluginManagerDesignFixture,
} from '../plugin-manager/plugin-manager-fixtures';

const incompatibleActions = {
  install: false,
  repair: false,
  setEnabled: false,
  uninstall: true,
  blockingReasons: ['package-incompatible'],
};
const incompatible: PluginManagerDesignFixture = {
  ...PLUGIN_MANAGER_DESIGN_FIXTURES[0],
  id: 'incompatible',
  displayName: 'Feishu Meeting',
  artifact: 'installed',
  installedVersion: '0.1.0',
  availableVersion: '0.1.0',
  intent: 'disabled',
  live: 'stopped',
  config: 'ready',
  auth: 'not-required',
  configFields: [],
  steps: [],
  setupSteps: [],
  actions: incompatibleActions,
};

function requiredElement(container: Element, selector: string) {
  const element = container.querySelector(selector);
  if (!element) throw new Error(`Missing rendered element: ${selector}`);
  return element;
}

describe('loaded-page state and update follow-up', () => {
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

  it.each([
    'zh-CN',
    'en',
  ])('uses grey for incompatible disabled state and gives no impossible update instruction (%s)', (locale) => {
    const onInstall = vi.fn(),
      onSetEnabled = vi.fn();
    act(() =>
      root.render(
        <PluginManagerContent
          presentation="v2"
          locale={locale}
          fixtures={[incompatible]}
          onInstall={onInstall}
          onSetEnabled={onSetEnabled}
        />,
      ),
    );
    const row = requiredElement(container, '[data-plugin-id="incompatible"]');
    const notice = requiredElement(container, '[data-plugin-detail-section="attention"]');
    expect(notice.textContent).toContain(
      locale === 'en' ? 'No compatible update is currently available' : '当前没有可用的兼容更新',
    );
    expect(
      row.querySelector('[data-plugin-summary] [aria-hidden]')?.classList.contains('bg-[var(--cafe-text-muted)]'),
    ).toBe(true);
    expect(notice.querySelector('[aria-hidden]')?.classList.contains('bg-[var(--cafe-text-muted)]')).toBe(true);
    expect(container.querySelector('[data-plugin-primary-action="update"]')).toBeNull();
    expect(container.querySelector('[data-plugin-detail-action="update"]')).toBeNull();
    act(() => row.querySelector<HTMLButtonElement>('button[data-enabled]')?.click());
    expect(row.querySelector('output')?.textContent).toContain(
      locale === 'en' ? 'No compatible update is currently available' : '当前没有可用的兼容更新',
    );
    expect(onInstall).not.toHaveBeenCalled();
    expect(onSetEnabled).not.toHaveBeenCalled();
  });

  it.each([
    'zh-CN',
    'en',
  ])('keeps the Host update path without claiming an unvalidated candidate is compatible (%s)', (locale) => {
    const candidate = {
      ...incompatible,
      availableVersion: '0.2.0',
      actions: { ...incompatibleActions, install: true },
    };
    const onInstall = vi.fn();
    act(() =>
      root.render(
        <PluginManagerContent presentation="v2" locale={locale} fixtures={[candidate]} onInstall={onInstall} />,
      ),
    );
    const notice = requiredElement(container, '[data-plugin-detail-section="attention"]');
    expect(notice.textContent).toContain(locale === 'en' ? 'checked before installation' : '安装前会校验兼容性');
    expect(notice.textContent).not.toContain(
      locale === 'en' ? 'Update to a compatible plugin version' : '请更新到兼容当前 Host',
    );
    const update = container.querySelector<HTMLButtonElement>('[data-plugin-detail-action="update"]');
    expect(update?.textContent).toContain('0.2.0');
    act(() => update?.click());
    expect(onInstall).toHaveBeenCalledExactlyOnceWith('incompatible');
  });

  it('distinguishes new-version blue from runtime-error amber in both row and detail notices', () => {
    const update = {
      ...incompatible,
      id: 'update',
      intent: 'enabled' as const,
      live: 'running' as const,
      availableVersion: '0.2.0',
      actions: { ...incompatibleActions, install: true, setEnabled: true, blockingReasons: [] },
    };
    const broken = { ...update, id: 'broken', live: 'crashed' as const, actions: { ...update.actions, repair: true } };
    act(() =>
      root.render(
        <PluginManagerContent
          presentation="v2"
          fixtures={[update, broken]}
          selectedPluginId="broken"
          onInstall={vi.fn()}
          onRepair={vi.fn()}
        />,
      ),
    );
    const updateRow = requiredElement(container, '[data-plugin-id="update"]');
    const brokenRow = requiredElement(container, '[data-plugin-id="broken"]');
    expect(
      updateRow.querySelector('[data-plugin-summary] [aria-hidden]')?.classList.contains('bg-conn-blue-text'),
    ).toBe(true);
    expect(
      brokenRow.querySelector('[data-plugin-summary] [aria-hidden]')?.classList.contains('bg-conn-amber-text'),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-plugin-detail-section="attention"] [aria-hidden]')
        ?.classList.contains('bg-conn-amber-text'),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-plugin-detail-section="update"] [aria-hidden]')
        ?.classList.contains('bg-conn-blue-text'),
    ).toBe(true);
  });

  it('retains the frozen classic presentation and its existing blocked-enable wording', () => {
    act(() => root.render(<PluginManagerContent presentation="v1" fixtures={[incompatible]} />));
    expect(container.querySelector('[data-plugin-summary]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('button[data-enabled]')?.click());
    expect(container.querySelector('output')?.textContent).toContain('请更新到兼容当前 Host 的插件版本');
  });
});
