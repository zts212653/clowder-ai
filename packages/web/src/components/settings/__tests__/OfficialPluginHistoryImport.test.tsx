import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { OfficialPluginsPanel } from '../OfficialPluginsPanel';

const mockApiFetch = vi.mocked(apiFetch);
const digest = 'sha512-KxdTlM24eKnXy6NE3TmbP78ro5D6lAX+m0H3LN4MrfI6SVz9BQnntHDxobjz4B+5wJ3gl0i7BX3ZOjBnhFby/w==';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function runningPlugin() {
  return {
    catalogId: 'feishu-meeting-intake',
    packageName: '@clowder-ai/feishu-meeting-intake',
    version: '0.1.0-alpha.6',
    availableVersion: '0.1.0-alpha.6',
    pluginId: 'official.feishu-meeting-intake',
    packageDigest: digest,
    effectiveGrants: ['events.publish'],
    ownerAuthAvailable: true,
    updateAvailable: false,
    instance: {
      pluginInstanceId: 'pi_official',
      installedVersion: '0.1.0-alpha.6',
      packageDigest: digest,
      lifecycleState: 'installed',
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'healthy',
      lifecycleRevision: 11,
      installedAt: 1,
      updatedAt: 2,
    },
  };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('OfficialPluginHistoryImport', () => {
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
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('imports an owner-pasted historical Minute through the current lifecycle revision', async () => {
    const plugin = runningPlugin();
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/official' && !init) return jsonResponse({ plugins: [plugin] });
      if (url === '/api/plugins/official/pi_official/auth' && !init) return jsonResponse({ status: 'connected' });
      if (url === '/api/plugins/official/pi_official/history-import') {
        return jsonResponse({ publicationId: 'pub-history', disposition: 'accepted' });
      }
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<OfficialPluginsPanel />));
    await flushEffects();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="查看飞书会议纪要同步详情"]')?.click();
    });
    const input = container.querySelector<HTMLInputElement>('[aria-label="飞书妙记链接或 token"]');
    expect(input).toBeInstanceOf(HTMLInputElement);
    if (!(input instanceof HTMLInputElement)) throw new Error('historical import input is unavailable');
    await act(async () => setInputValue(input, '  obcne9c5d9z4l3o3nk9mg777  '));
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('导入历史妙记'))
        ?.click();
      await Promise.resolve();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/official/pi_official/history-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 11, reference: 'obcne9c5d9z4l3o3nk9mg777' }),
    });
    expect(container.textContent).toContain('历史妙记已进入待处理列表');
  });

  it('does not expose historical import while the runtime is stopped', async () => {
    const plugin = runningPlugin();
    plugin.instance.activationState = 'disabled';
    plugin.instance.runtimeState = 'stopped';
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/official' && !init) return jsonResponse({ plugins: [plugin] });
      if (url === '/api/plugins/official/pi_official/auth' && !init) return jsonResponse({ status: 'connected' });
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<OfficialPluginsPanel />));
    await flushEffects();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="查看飞书会议纪要同步详情"]')?.click();
    });
    expect(container.querySelector('[aria-label="飞书妙记链接或 token"]')).toBeNull();
  });
});
