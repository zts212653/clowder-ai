import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { OfficialPluginsPanel } from '../OfficialPluginsPanel';

const mockApiFetch = vi.mocked(apiFetch);
const digest = 'sha512-KxdTlM24eKnXy6NE3TmbP78ro5D6lAX+m0H3LN4MrfI6SVz9BQnntHDxobjz4B+5wJ3gl0i7BX3ZOjBnhFby/w==';

function plugin(instance: Record<string, unknown> | null, ownerAuthAvailable = false) {
  return {
    catalogId: 'feishu-meeting-intake',
    packageName: '@clowder-ai/feishu-meeting-intake',
    version: '0.1.0-alpha.1',
    availableVersion: '0.1.0-alpha.1',
    pluginId: 'official.feishu-meeting-intake',
    packageDigest: digest,
    effectiveGrants: ['events.publish'],
    ownerAuthAvailable,
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

describe('OfficialPluginsPanel', () => {
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

  it('shows immutable package truth and installs without auto-starting', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/official' && !init) return jsonResponse({ plugins: [plugin(null)] });
      if (url.endsWith('/install')) {
        return jsonResponse(
          plugin({
            pluginInstanceId: 'pi_official',
            lifecycleState: 'installed',
            configReadiness: 'ready',
            activationState: 'disabled',
            runtimeState: 'stopped',
            lifecycleRevision: 2,
            installedAt: 1,
            updatedAt: 2,
          }),
        );
      }
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<OfficialPluginsPanel />));
    await flushEffects();
    await act(async () => findButtonByAriaLabel(container, '查看飞书会议纪要同步详情')?.click());
    expect(container.textContent).toContain('0.1.0-alpha.1');
    expect(container.textContent).toContain('sha512-KxdTlM24');

    await act(async () => findButton(container, '安装')?.click());
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/official/feishu-meeting-intake/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedCatalogVersion: '0.1.0-alpha.1',
        expectedPackageDigest: digest,
      }),
    });
    expect(mockApiFetch.mock.calls.some(([url]) => String(url).endsWith('/enable'))).toBe(false);
    expect(container.textContent).toContain('已安装，尚未接收新生成的飞书会议纪要');
  });

  it('uses the compact plugin-row language and keeps package truth in expandable details', async () => {
    const running = plugin({
      pluginInstanceId: 'pi_official',
      lifecycleState: 'installed',
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'healthy',
      lifecycleRevision: 4,
      installedAt: 1,
      updatedAt: 2,
    });
    mockApiFetch.mockResolvedValue(jsonResponse({ plugins: [running] }));

    await act(async () => root.render(<OfficialPluginsPanel />));
    await flushEffects();

    expect(container.textContent).toContain('飞书会议纪要同步');
    expect(container.textContent).toContain('自动接收飞书生成的智能纪要和文字稿，交给猫猫整理');
    expect(container.textContent).not.toContain('官方运行时插件');
    expect(container.textContent).not.toContain('@clowder-ai/feishu-meeting-intake');
    expect(container.querySelector('.settings-resource-row')).not.toBeNull();
    expect(findButtonByAriaLabel(container, '停用飞书会议纪要同步')).not.toBeUndefined();

    await act(async () => findButtonByAriaLabel(container, '查看飞书会议纪要同步详情')?.click());
    expect(container.textContent).toContain('@clowder-ai/feishu-meeting-intake');
    expect(container.textContent).toContain('sha512-KxdTlM24');
  });

  it('refreshes visible runtime health and offers repair after an enabled process crashes', async () => {
    vi.useFakeTimers();
    const healthy = plugin({
      pluginInstanceId: 'pi_official',
      lifecycleState: 'installed',
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'healthy',
      lifecycleRevision: 4,
      installedAt: 1,
      updatedAt: 2,
    });
    const crashed = plugin({
      ...healthy.instance,
      runtimeState: 'crashed',
      lifecycleRevision: 5,
      updatedAt: 3,
    });
    let reads = 0;
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins/official') {
        reads += 1;
        return jsonResponse({ plugins: [reads === 1 ? healthy : crashed] });
      }
      if (url.endsWith('/repair')) {
        return jsonResponse({ ...crashed, instance: { ...crashed.instance, activationState: 'disabled' } });
      }
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<OfficialPluginsPanel />));
    await flushEffects();
    expect(container.textContent).toContain('运行中');

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(reads).toBe(2);
    expect(container.textContent).toContain('需修复');
    expect(container.textContent).not.toContain('运行中');

    await act(async () => findButton(container, '修复')?.click());
    await flushEffects();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/official/pi_official/repair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 5 }),
    });
  });

  it('requires explicit confirmation and sends the current revision when enabling', async () => {
    const installed = plugin({
      pluginInstanceId: 'pi_official',
      lifecycleState: 'installed',
      configReadiness: 'ready',
      activationState: 'disabled',
      runtimeState: 'stopped',
      lifecycleRevision: 7,
      installedAt: 1,
      updatedAt: 2,
    });
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins/official') return jsonResponse({ plugins: [installed] });
      if (url.endsWith('/enable')) {
        return jsonResponse({ ...installed, instance: { ...installed.instance, activationState: 'enabled' } });
      }
      return jsonResponse({}, 404);
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);

    await act(async () => root.render(<OfficialPluginsPanel />));
    await flushEffects();
    await act(async () => findButtonByAriaLabel(container, '启用飞书会议纪要同步')?.click());
    expect(mockApiFetch.mock.calls.some(([url]) => String(url).endsWith('/enable'))).toBe(false);

    await act(async () => findButtonByAriaLabel(container, '启用飞书会议纪要同步')?.click());
    await flushEffects();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/official/pi_official/enable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 7 }),
    });
  });

  it('shows Lark repair guidance and refreshes after a stale revision conflict', async () => {
    const failed = plugin({
      pluginInstanceId: 'pi_official',
      lifecycleState: 'installed',
      configReadiness: 'ready',
      activationState: 'error',
      runtimeState: 'stopped',
      lifecycleRevision: 9,
      installedAt: 1,
      updatedAt: 2,
    });
    let reads = 0;
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins/official') {
        reads += 1;
        return jsonResponse({ plugins: [failed] });
      }
      if (url.endsWith('/repair')) return jsonResponse({ error: 'state changed', code: 'STALE_REVISION' }, 409);
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<OfficialPluginsPanel />));
    await flushEffects();
    await act(async () => findButtonByAriaLabel(container, '查看飞书会议纪要同步详情')?.click());
    expect(container.textContent).toContain('请确认飞书账号授权有效');
    expect(container.textContent).not.toContain('lark-cli auth login');

    await act(async () => findButton(container, '修复')?.click());
    await flushEffects();
    expect(container.textContent).toContain('状态已变化');
    expect(reads).toBe(2);
  });

  it('runs user OAuth as an in-card action and unlocks enable after the QR flow completes', async () => {
    vi.useFakeTimers();
    const installed = plugin(
      {
        pluginInstanceId: 'pi_official',
        lifecycleState: 'installed',
        configReadiness: 'ready',
        activationState: 'disabled',
        runtimeState: 'stopped',
        lifecycleRevision: 7,
        installedAt: 1,
        updatedAt: 2,
      },
      true,
    );
    let authReads = 0;
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/official') return jsonResponse({ plugins: [installed] });
      if (url === '/api/plugins/official/pi_official/auth' && !init) {
        authReads += 1;
        return jsonResponse({ status: authReads === 1 ? 'not_connected' : 'connected' });
      }
      if (url === '/api/plugins/official/pi_official/auth/start') {
        return jsonResponse({
          status: 'waiting',
          verificationUrl: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=opaque&user_code=ABCD-EFGH',
          userCode: 'ABCD-EFGH',
          qrDataUrl: 'data:image/png;base64,qr',
        });
      }
      return jsonResponse({}, 404);
    });

    await act(async () => root.render(<OfficialPluginsPanel />));
    await flushEffects();
    expect(findButton(container, '连接飞书')).not.toBeUndefined();
    expect(findButtonByAriaLabel(container, '启用飞书会议纪要同步')).toBeUndefined();

    await act(async () => findButton(container, '连接飞书')?.click());
    await flushEffects();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/official/pi_official/auth/start', { method: 'POST' });
    expect(container.textContent).toContain('ABCD-EFGH');
    expect(container.textContent).not.toContain('lark-cli auth login');
    expect(container.querySelector('[data-testid="feishu-meeting-intake-qr-image"]')).not.toBeNull();
    const link = container.querySelector<HTMLAnchorElement>('a[data-testid="feishu-meeting-intake-auth-link"]');
    expect(link?.href).toContain('accounts.feishu.cn/oauth/v1/device/verify');

    await act(async () => {
      vi.advanceTimersByTime(2_500);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('飞书账号已连接');
    expect(findButtonByAriaLabel(container, '启用飞书会议纪要同步')).not.toBeUndefined();
  });
});
