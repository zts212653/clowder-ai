import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubConfigPanel } from '../GithubConfigPanel';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function connectorStatusResponse(): Response {
  return jsonResponse({
    platforms: [
      {
        id: 'github',
        fields: [
          { envName: 'GITHUB_TOKEN', label: 'Personal Access Token', sensitive: true, currentValue: '••••••••' },
          {
            envName: 'GITHUB_SETUP_NOISE_BOT_LOGINS',
            label: 'Noise 过滤 Bot 列表',
            sensitive: false,
            currentValue: 'chatgpt-codex-connector[bot]',
            restartRequired: true,
          },
          { envName: 'GITHUB_MCP_PAT', label: 'MCP 专用 Token', sensitive: true, currentValue: '••••••••' },
        ],
      },
    ],
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  return button as HTMLButtonElement;
}

describe('GithubConfigPanel', () => {
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
    mocks.apiFetch.mockImplementation((path: string) => {
      if (path === '/api/connector/status') return Promise.resolve(connectorStatusResponse());
      return Promise.resolve(jsonResponse({ ok: true }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('saves edited GitHub token without resending omitted secret fields', async () => {
    await act(async () => {
      root.render(React.createElement(GithubConfigPanel));
    });

    const tokenInput = container.querySelector('input[name="GITHUB_TOKEN"]') as HTMLInputElement | null;
    const mcpInput = container.querySelector('input[name="GITHUB_MCP_PAT"]') as HTMLInputElement | null;
    expect(tokenInput).not.toBeNull();
    expect(mcpInput).not.toBeNull();

    await act(async () => {
      setInputValue(tokenInput as HTMLInputElement, 'ghp_new_token');
    });
    await act(async () => {
      findButton(container, '保存 GitHub 配置').click();
    });

    const saveCall = mocks.apiFetch.mock.calls.find(([path]) => path === '/api/config/secrets');
    expect(saveCall).toBeDefined();
    const body = JSON.parse(String((saveCall?.[1] as RequestInit).body));
    expect(body.updates).toEqual([{ name: 'GITHUB_TOKEN', value: 'ghp_new_token' }]);
  });

  it('shows owner fail-closed errors from the save endpoint', async () => {
    mocks.apiFetch.mockImplementation((path: string) => {
      if (path === '/api/connector/status') return Promise.resolve(connectorStatusResponse());
      if (path === '/api/config/secrets') {
        return Promise.resolve(
          jsonResponse({ error: 'Connector credential writes require DEFAULT_OWNER_USER_ID to be configured' }, 403),
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    await act(async () => {
      root.render(React.createElement(GithubConfigPanel));
    });

    const tokenInput = container.querySelector('input[name="GITHUB_TOKEN"]') as HTMLInputElement | null;
    await act(async () => {
      setInputValue(tokenInput as HTMLInputElement, 'ghp_new_token');
    });
    await act(async () => {
      findButton(container, '保存 GitHub 配置').click();
    });

    expect(container.textContent).toContain('DEFAULT_OWNER_USER_ID 未配置');
  });

  it('marks GitHub setup noise bot logins as restart-required', async () => {
    await act(async () => {
      root.render(React.createElement(GithubConfigPanel));
    });

    const noiseInput = container.querySelector('input[name="GITHUB_SETUP_NOISE_BOT_LOGINS"]');
    expect(noiseInput).not.toBeNull();
    expect(container.textContent).toContain('重启 API 后生效');
  });
});
