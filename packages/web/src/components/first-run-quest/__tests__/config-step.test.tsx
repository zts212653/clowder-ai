import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { ConfigStep } from '../ConfigStep';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it('uses a detected logged-in CLI when the Clowder account catalog is empty', async () => {
  const onComplete = vi.fn();
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === '/api/accounts'
            ? { providers: [] }
            : url === '/api/cat-templates'
              ? { clientDefaults: { codex: { defaultModel: 'gpt-test', models: ['gpt-test'] } } }
              : { ok: true, message: '连接成功' },
        ),
      ),
  );

  await act(async () => {
    root.render(<ConfigStep client="codex" clientId="openai" detectedOAuth onComplete={onComplete} />);
  });
  expect(container.textContent).toContain('本机 CLI 登录');
  expect(container.textContent).not.toContain('未找到可用账号');
  expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === '编辑')).toBe(false);
  expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === '+ 添加')).toBe(
    false,
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="first-run-connect-test"]')?.click();
  });
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
    '/api/first-run/connectivity-test',
    expect.objectContaining({
      body: JSON.stringify({ profileId: 'codex', clientId: 'openai', client: 'codex', model: 'gpt-test' }),
    }),
  );
  const create = container.querySelector<HTMLButtonElement>('[data-testid="first-run-create-cat"]');
  expect(create?.disabled).toBe(false);
  await act(async () => {
    create?.click();
  });
  expect(onComplete).toHaveBeenCalledWith({ accountRef: 'codex', model: 'gpt-test' });
});

it('keeps the native CLI usable when template defaults have no model', async () => {
  const onComplete = vi.fn();
  vi.mocked(apiFetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === '/api/accounts'
            ? { providers: [] }
            : url === '/api/cat-templates'
              ? { clientDefaults: {} }
              : { ok: true, message: '连接成功' },
        ),
      ),
  );
  await act(async () => {
    root.render(<ConfigStep client="codex" clientId="openai" detectedOAuth onComplete={onComplete} />);
  });
  const testButton = container.querySelector<HTMLButtonElement>('[data-testid="first-run-connect-test"]');
  expect(testButton?.disabled).toBe(false);
  await act(async () => {
    testButton?.click();
  });
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
    '/api/first-run/connectivity-test',
    expect.objectContaining({
      body: JSON.stringify({ profileId: 'codex', clientId: 'openai', client: 'codex' }),
    }),
  );
  const create = container.querySelector<HTMLButtonElement>('[data-testid="first-run-create-cat"]');
  expect(create?.disabled).toBe(false);
  await act(async () => {
    create?.click();
  });
  expect(onComplete).toHaveBeenCalledWith({ accountRef: 'codex', model: '' });
});

it('still requires a model for an API-key profile', async () => {
  const onComplete = vi.fn();
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        providers: [
          { id: 'custom', clientId: 'openai', name: 'Custom', authType: 'api_key', models: [], hasApiKey: true },
        ],
      }),
    ),
  );
  await act(async () => {
    root.render(<ConfigStep client="codex" clientId="openai" onComplete={onComplete} />);
  });
  expect(container.querySelector<HTMLButtonElement>('[data-testid="first-run-connect-test"]')?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[data-testid="first-run-create-cat"]')?.disabled).toBe(true);
  expect(onComplete).not.toHaveBeenCalled();
});
