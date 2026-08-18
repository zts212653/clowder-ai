import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { OfficialPluginsPanel } from '../OfficialPluginsPanel';

const mockApiFetch = vi.mocked(apiFetch);
const digest = 'sha512-KxdTlM24eKnXy6NE3TmbP78ro5D6lAX+m0H3LN4MrfI6SVz9BQnntHDxobjz4B+5wJ3gl0i7BX3ZOjBnhFby/w==';

function plugin(instance: Record<string, unknown> | null) {
  return {
    catalogId: 'feishu-meeting-intake',
    packageName: '@clowder-ai/feishu-meeting-intake',
    version: '0.1.0-alpha.1',
    availableVersion: '0.1.0-alpha.1',
    pluginId: 'official.feishu-meeting-intake',
    packageDigest: digest,
    effectiveGrants: ['events.publish'],
    ownerAuthAvailable: false,
    updateAvailable: false,
    instance:
      instance === null
        ? null
        : {
            installedVersion: '0.1.0-alpha.1',
            packageDigest: digest,
            ...instance,
          },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(label));
}

function findButtonByAriaLabel(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('button')).find((button) => button.getAttribute('aria-label') === label);
}

describe('OfficialPluginsPanel catalog refresh', () => {
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
    vi.useRealTimers();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows installed versus available versions and only updates after an explicit owner action', async () => {
    const nextDigest = 'sha512-TkVYVA==';
    const old = {
      ...plugin({
        pluginInstanceId: 'pi_official',
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'error',
        runtimeState: 'stopped',
        lifecycleRevision: 9,
        installedAt: 1,
        updatedAt: 2,
      }),
      version: '0.1.0-alpha.3',
      availableVersion: '0.1.0-alpha.3',
      packageDigest: nextDigest,
      updateAvailable: true,
    };
    const updated = {
      ...old,
      updateAvailable: false,
      instance: {
        ...old.instance,
        installedVersion: '0.1.0-alpha.3',
        packageDigest: nextDigest,
        activationState: 'disabled',
        lifecycleRevision: 10,
      },
    };
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins/official') return jsonResponse({ plugins: [old] });
      if (url.endsWith('/update')) return jsonResponse(updated);
      return jsonResponse({}, 404);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => root.render(<OfficialPluginsPanel />));
    await flushEffects();
    await act(async () => findButtonByAriaLabel(container, '查看飞书会议纪要同步详情')?.click());
    expect(container.textContent).toContain('已安装 0.1.0-alpha.1');
    expect(container.textContent).toContain('可用 0.1.0-alpha.3');

    await act(async () => findButton(container, '更新到 0.1.0-alpha.3')?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/official/pi_official/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 9,
        expectedCatalogVersion: old.availableVersion,
        expectedPackageDigest: old.packageDigest,
      }),
    });
    expect(mockApiFetch.mock.calls.some(([url]) => String(url).endsWith('/enable'))).toBe(false);
    expect(container.textContent).toContain('0.1.0-alpha.3');
  });

  it('discovers a newer trusted release through the existing poll without remounting', async () => {
    vi.useFakeTimers();
    const installed = plugin({
      pluginInstanceId: 'pi_official',
      lifecycleState: 'installed',
      configReadiness: 'ready',
      activationState: 'disabled',
      runtimeState: 'stopped',
      lifecycleRevision: 4,
      installedAt: 1,
      updatedAt: 2,
    });
    const alpha5 = {
      ...installed,
      version: '0.1.0-alpha.5',
      availableVersion: '0.1.0-alpha.5',
      packageDigest: `sha512-${Buffer.alloc(64, 5).toString('base64')}`,
      updateAvailable: true,
    };
    let reads = 0;
    mockApiFetch.mockImplementation(async (url) => {
      if (url !== '/api/plugins/official') return jsonResponse({}, 404);
      reads += 1;
      return jsonResponse({
        plugins: [reads === 1 ? installed : alpha5],
        catalog: { status: 'fresh', checkedAt: reads },
      });
    });

    await act(async () => root.render(<OfficialPluginsPanel />));
    await flushEffects();
    expect(findButton(container, '更新到')).toBeUndefined();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(reads).toBe(2);
    expect(findButton(container, '更新到 0.1.0-alpha.5')).not.toBeUndefined();
  });

  it('keeps last-known-good plugin truth visible when catalog refresh is degraded', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        plugins: [plugin(null)],
        catalog: { status: 'degraded', checkedAt: 1_000, errorCode: 'CATALOG_FETCH_FAILED' },
      }),
    );

    await act(async () => root.render(<OfficialPluginsPanel />));
    await flushEffects();

    expect(container.textContent).toContain('版本目录暂时无法刷新');
    expect(container.textContent).toContain('当前显示最近一次可信版本');
    expect(container.textContent).toContain('飞书会议纪要同步');
  });
});
