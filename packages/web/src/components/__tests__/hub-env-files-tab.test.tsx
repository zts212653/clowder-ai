import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

import { HubEnvFilesTab } from '@/components/HubEnvFilesTab';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function changeField(element: HTMLInputElement, value: string) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('HubEnvFilesTab', () => {
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
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/config/env-summary' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            categories: { server: '服务器', storage: '存储' },
            variables: [
              {
                name: 'API_SERVER_PORT',
                defaultValue: '3003',
                description: 'API 服务端口',
                category: 'server',
                sensitive: false,
                runtimeEditable: false,
                currentValue: '3003',
              },
              {
                name: 'FRONTEND_URL',
                defaultValue: '(自动检测)',
                description: '前端 URL（导出长图用）',
                category: 'server',
                sensitive: false,
                runtimeEditable: true,
                currentValue: 'http://localhost:3004',
              },
              {
                name: 'REDIS_URL',
                defaultValue: '(未设置)',
                description: 'Redis 连接地址',
                category: 'storage',
                sensitive: false,
                maskMode: 'url',
                currentValue: 'redis://***@localhost:6379/15',
              },
              {
                name: 'OPENAI_API_KEY',
                defaultValue: '(未设置)',
                description: 'OpenAI API Key',
                category: 'server',
                sensitive: true,
                currentValue: '***',
              },
            ],
            paths: {
              projectRoot: '/tmp/project',
              homeDir: '/tmp/home',
              dataDirs: {
                auditLogs: '/tmp/project/data/audit-logs',
                cliArchive: '/tmp/project/data/cli-raw-archive',
                redisDevSandbox: '/tmp/home/.cat-cafe/redis-dev-sandbox',
                uploads: '/tmp/project/uploads',
              },
            },
          }),
        );
      }
      if (path === '/api/config/env' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('renders editable env vars, keeps credentials masked, and saves back to .env', async () => {
    await act(async () => {
      root.render(React.createElement(HubEnvFilesTab));
    });
    await flushEffects();

    expect(container.textContent).toContain('cat-template.json');
    expect(container.textContent).toContain('.cat-cafe/cat-catalog.json');
    expect(container.querySelector('input[aria-label="API_SERVER_PORT"]')).toBeNull();
    expect(container.querySelector('input[aria-label="FRONTEND_URL"]')).toBeTruthy();
    expect(container.querySelector('input[aria-label="OPENAI_API_KEY"]')).toBeNull();
    expect(container.textContent).toContain('***');

    const frontendUrlInput = container.querySelector('input[aria-label="FRONTEND_URL"]') as HTMLInputElement;
    await changeField(frontendUrlInput, 'http://localhost:3200');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存到 .env');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(([path, init]) => path === '/api/config/env' && init?.method === 'PATCH');
    expect(patchCall).toBeTruthy();
    expect(String(patchCall?.[1]?.body)).toContain('FRONTEND_URL');
    expect(String(patchCall?.[1]?.body)).toContain('http://localhost:3200');
    expect(String(patchCall?.[1]?.body)).not.toContain('API_SERVER_PORT');
  });
});
