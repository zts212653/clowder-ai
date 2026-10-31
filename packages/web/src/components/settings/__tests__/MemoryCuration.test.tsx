import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryCurationSettings } from '../MemoryCurationSettings';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetchMock }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
let host: HTMLDivElement;
let root: Root;
const settings = { enabled: false, modelLabel: '缅因猫 Luna', systemThreadId: 'thread_ops', startedAt: null };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

it('saves the one switch through the owner endpoint and re-reads the durable setting', async () => {
  let current = settings;
  fetchMock.mockImplementation(async (_path: string, init?: RequestInit) => {
    if (init?.method === 'PUT') current = { ...current, ...JSON.parse(String(init.body)) };
    return { ok: true, json: async () => current };
  });
  await act(async () => root.render(<MemoryCurationSettings />));
  expect(host.textContent).toContain('已关闭');
  expect([...host.querySelectorAll('a')].some((link) => link.textContent === '看这段时间')).toBe(false);
  const toggle = host.querySelector('button[aria-label="记忆整理"]') as HTMLButtonElement;
  await act(async () => toggle.click());
  expect(host.textContent).toContain('已开启');
  expect(fetchMock.mock.calls.find((call) => call[1]?.method === 'PUT')?.[1].body).toBe('{"enabled":true}');
});

it('failed writes retain the actual off state and say the switch was not saved', async () => {
  fetchMock.mockImplementation(async (_path: string, init?: RequestInit) => ({
    ok: init?.method !== 'PUT',
    json: async () => settings,
  }));
  await act(async () => root.render(<MemoryCurationSettings />));
  await act(async () => (host.querySelector('button[aria-label="记忆整理"]') as HTMLButtonElement).click());
  expect(host.textContent).toContain('开关没有保存');
  expect(host.textContent).toContain('已关闭');
});

it('keeps the operations thread link for existing records while withdrawing the page link', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...settings, startedAt: 100 }) });
  await act(async () => root.render(<MemoryCurationSettings />));
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/thread/thread_ops');
  expect(host.textContent).toContain('运行记录与花费');
  expect(host.querySelector('a[href*="/memory"]')).toBeNull();
});
