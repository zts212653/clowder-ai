import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ProviderCliStatus rendering contract.
 *
 * Two things are being defended:
 *
 *  1. **No request on mount.** A self-fetching child runs its effect before its parent's
 *     (React effects are bottom-up), so mounting this card inside the member editor injected a
 *     request ahead of the editor's own and consumed the response the editor had queued —
 *     which broke `hub-cat-editor.test.tsx`. Detection is click-triggered instead.
 *  2. **Unknown is never rendered as "not installed".** Painting a working CLI as missing
 *     would send the user to reinstall something they already have.
 */

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

function provider(overrides: Record<string, unknown> = {}) {
  return {
    clientId: 'anthropic',
    toolId: 'claude',
    label: 'Claude',
    installed: true,
    command: 'claude',
    resolvedPath: '/usr/local/bin/claude',
    resolvedVia: 'path',
    hasApiKey: false,
    status: 'configured',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    localCli: true,
    ...overrides,
  };
}

function okResponse(providers: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ providers }) };
}

describe('ProviderCliStatus', () => {
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
    apiFetchMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  async function render(clientId = 'anthropic') {
    const { ProviderCliStatus } = await import('../ProviderCliStatus');
    await act(async () => {
      root.render(React.createElement(ProviderCliStatus, { clientId }));
    });
  }

  async function clickButton(label: string) {
    const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.includes(label));
    expect(button, `missing button "${label}"`).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  async function renderAndDetect(clientId = 'anthropic') {
    await render(clientId);
    await clickButton('检测本机 CLI');
  }

  it('does not touch the network until the user asks', async () => {
    apiFetchMock.mockResolvedValue(okResponse([provider()]));
    await render();

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('检测本机 CLI');

    await clickButton('检测本机 CLI');
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/clients');
  });

  it('shows the resolved path for an installed client', async () => {
    apiFetchMock.mockResolvedValue(okResponse([provider()]));
    await renderAndDetect();

    expect(container.textContent).toContain('已安装');
    expect(container.textContent).toContain('/usr/local/bin/claude');
    expect(container.textContent).toContain('本机已安装：Claude');
  });

  it('hands over the install command for a missing client', async () => {
    apiFetchMock.mockResolvedValue(
      okResponse([provider({ installed: false, status: 'missing', resolvedPath: undefined, reason: '未在本机找到' })]),
    );
    await renderAndDetect();

    expect(container.textContent).toContain('未安装');
    expect(container.textContent).toContain('npm install -g @anthropic-ai/claude-code');
    expect(container.textContent).toContain('本机未检测到任何本地 CLI');
  });

  it('never reports a failed request as "not installed"', async () => {
    apiFetchMock.mockRejectedValue(new Error('offline'));
    await renderAndDetect();

    expect(container.textContent).toContain('本机 CLI 状态不可用');
    expect(container.textContent).not.toContain('未安装');
  });

  it('treats a 4xx/5xx response as unknown too', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await renderAndDetect();

    expect(container.textContent).toContain('本机 CLI 状态不可用');
    expect(container.textContent).not.toContain('未安装');
  });

  it('says a bridged client needs no local CLI instead of "missing"', async () => {
    apiFetchMock.mockResolvedValue(
      okResponse([
        provider({ clientId: 'antigravity', toolId: null, localCli: false, installed: false, status: 'unsupported' }),
      ]),
    );
    await renderAndDetect('antigravity');

    expect(container.textContent).toContain('无需本机 CLI');
    expect(container.textContent).not.toContain('未安装');
  });

  it('surfaces a broken path override as a configuration error, not a missing binary', async () => {
    apiFetchMock.mockResolvedValue(
      okResponse([
        provider({
          installed: false,
          status: 'error',
          resolvedPath: undefined,
          reason: 'CAT_ANTHROPIC_PATH 指向的路径不存在',
        }),
      ]),
    );
    await renderAndDetect();

    expect(container.textContent).toContain('配置有误');
    expect(container.textContent).toContain('CAT_ANTHROPIC_PATH');
  });

  it('re-detects on demand', async () => {
    apiFetchMock.mockResolvedValue(okResponse([provider()]));
    await renderAndDetect();

    await clickButton('重新检测');

    const refreshCall = apiFetchMock.mock.calls.find((call) => call[0] === '/api/clients/refresh');
    expect(refreshCall).toBeTruthy();
    expect(refreshCall?.[1]).toMatchObject({ method: 'POST' });
  });
});
