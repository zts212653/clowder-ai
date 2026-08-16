import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { OfficialPluginsPanel } from '../OfficialPluginsPanel';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function eventBusConflictPlugin() {
  return {
    catalogId: 'feishu-meeting-intake',
    packageName: '@clowder-ai/feishu-meeting-intake',
    version: '0.1.0-alpha.3',
    availableVersion: '0.1.0-alpha.3',
    pluginId: 'official.feishu-meeting-intake',
    packageDigest: 'sha512-test',
    effectiveGrants: ['events.publish'],
    ownerAuthAvailable: false,
    updateAvailable: false,
    instance: {
      pluginInstanceId: 'pi_official',
      installedVersion: '0.1.0-alpha.3',
      packageDigest: 'sha512-test',
      lifecycleState: 'installed',
      configReadiness: 'ready',
      activationState: 'error',
      runtimeState: 'crashed',
      lifecycleRevision: 10,
      installedAt: 1,
      updatedAt: 2,
      lastRuntimeError: {
        code: 'EVENT_BUS_CONFLICT',
        exitCode: 17,
        signal: null,
        occurredAt: 2,
      },
    },
  };
}

describe('Official plugin runtime diagnostics', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('explains an event-bus conflict and retries through explicit enable', async () => {
    const plugin = eventBusConflictPlugin();
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins/official') return jsonResponse({ plugins: [plugin] });
      if (url.endsWith('/enable')) return jsonResponse(plugin);
      return jsonResponse({}, 404);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => root.render(<OfficialPluginsPanel />));
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain('连接被占用');

    const details = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === '查看飞书会议纪要同步详情',
    );
    await act(async () => details?.click());
    expect(container.textContent).toContain('另一台设备或服务正在使用同一个飞书应用的事件连接');
    expect(container.textContent).not.toContain('secret');

    const retry = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('重试连接'),
    );
    await act(async () => retry?.click());
    await act(async () => Promise.resolve());
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/official/pi_official/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 10 }),
    });
  });
});
