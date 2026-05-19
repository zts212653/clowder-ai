import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

import HubPermissionsTab from '../HubPermissionsTab';

describe('HubPermissionsTab', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        whitelistEnabled: false,
        commandAdminOnly: false,
        adminOpenIds: ['ou_admin1'],
        allowedGroups: [],
      }),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => {
      root.render(React.createElement(HubPermissionsTab, { connectorId: 'feishu', connectorLabel: '飞书' }));
    });
  }

  it('fetches permissions from /api/connector/permissions/:id', async () => {
    await render();

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/connector/permissions/feishu');
    expect(container.textContent).toContain('群聊权限管理');
    expect(container.textContent).toContain('ou_admin1');
  });

  it('uses SettingsResourceToggleSwitch for whitelist toggle', async () => {
    await render();

    const toggles = container.querySelectorAll('.settings-resource-toggle');
    expect(toggles.length).toBe(2);
  });

  it('whitelist toggle PUTs to /api/connector/permissions/:id immediately', async () => {
    await render();

    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        whitelistEnabled: true,
        commandAdminOnly: false,
        adminOpenIds: ['ou_admin1'],
        allowedGroups: [],
      }),
    });

    const toggles = container.querySelectorAll('.settings-resource-toggle');
    await act(async () => {
      (toggles[0] as HTMLElement)?.click();
    });

    const putCall = mocks.apiFetch.mock.calls.find(
      (c: unknown[]) => c[0] === '/api/connector/permissions/feishu' && (c[1] as { method?: string })?.method === 'PUT',
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse((putCall?.[1] as { body: string }).body)).toEqual({ whitelistEnabled: true });
  });

  it('never calls /api/connector/:id/config', async () => {
    await render();

    const toggles = container.querySelectorAll('.settings-resource-toggle');
    await act(async () => {
      (toggles[0] as HTMLElement)?.click();
    });

    const configCalls = mocks.apiFetch.mock.calls.filter((c: unknown[]) =>
      (c[0] as string).includes('/api/connector/feishu/config'),
    );
    expect(configCalls.length).toBe(0);
  });

  it('uses StepBadge for section numbering', async () => {
    await render();

    expect(container.textContent).toContain('1');
    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('群白名单');
    expect(container.textContent).toContain('管理员');
    expect(container.textContent).toContain('群聊命令仅管理员');
  });

  it('uses console-list-card wrapper', async () => {
    await render();

    const card = container.querySelector('.console-list-card');
    expect(card).toBeTruthy();
  });
});
