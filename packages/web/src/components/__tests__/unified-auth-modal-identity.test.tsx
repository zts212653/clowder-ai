import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { UnifiedAuthModal } from '../UnifiedAuthModal';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
const created = vi.fn();
const close = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(apiFetch)
    .mockReset()
    .mockResolvedValue(new Response(JSON.stringify({ profile: { id: 'fixture' } })));
  created.mockClear();
  close.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function fill(placeholder: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('standalone API key creation submits the selected identity', async () => {
  await act(async () => root.render(<UnifiedAuthModal open onClose={close} onCreated={created} />));
  await click('API Key');
  const select = document.querySelector('select');
  expect(select).toBeTruthy();
  await act(async () => {
    select!.value = 'openai';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await fill('例如: my-claude-account', 'fixture');
  await fill('https://api.openai.com/v1', 'https://gateway.invalid/v1');
  await fill('sk-...', 'FAKE_KEY');
  await click('+ 添加');
  await fill('输入模型名', 'fixture-model');
  await act(async () =>
    document
      .querySelector('input[placeholder="输入模型名"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  await click('保存');
  const body = JSON.parse(String(vi.mocked(apiFetch).mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({ authType: 'api_key', clientId: 'openai', apiKey: 'FAKE_KEY' });
  expect(created).toHaveBeenCalledWith('fixture');
});

it('editing a legacy API key account can declare identity without replacing its secret', async () => {
  await act(async () =>
    root.render(
      <UnifiedAuthModal
        open
        onClose={close}
        onCreated={created}
        editProfile={{
          id: 'legacy',
          displayName: 'legacy',
          authType: 'api_key',
          models: ['fixture'],
          baseUrl: 'https://gateway.invalid',
        }}
      />,
    ),
  );
  const select = document.querySelector('select');
  expect(select).toBeTruthy();
  expect(select!.value).toBe('');
  expect([...document.querySelectorAll('button')].find((item) => item.textContent === '保存')?.disabled).toBe(true);
  await act(async () => {
    select!.value = 'kimi';
    select!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await click('保存');
  const body = JSON.parse(String(vi.mocked(apiFetch).mock.calls[0]?.[1]?.body));
  expect(body.clientId).toBe('kimi');
  expect(body).not.toHaveProperty('apiKey');
});

it('a wizard identity stays locked and a rejected save retains input', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'fixture rejected' }), { status: 400 }));
  await act(async () =>
    root.render(
      <UnifiedAuthModal
        open
        onClose={close}
        onCreated={created}
        initialClientId="openai"
        editProfile={{
          id: 'fixture',
          displayName: 'fixture',
          clientId: 'openai',
          authType: 'api_key',
          models: ['fixture'],
          baseUrl: 'https://gateway.invalid',
        }}
      />,
    ),
  );
  expect(document.querySelector('select')).toBeNull();
  await fill('••••••••••••', 'FAKE_NEW_KEY');
  await click('保存');
  expect(document.body.textContent).toContain('fixture rejected');
  expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('FAKE_NEW_KEY');
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0]?.[1]?.body)).clientId).toBe('openai');
  expect(created).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});
