import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemorySettingsContent } from '../../settings/MemorySettingsContent';
import { ServiceStatusPanel } from '../../settings/ServiceStatusPanel';
import { IndexStatus } from '../IndexStatus';
import { MemoryFlagPanel } from '../MemoryFlagPanel';
import { ToolUsageMetricsPanel } from '../ToolUsageMetricsPanel';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
let container: HTMLDivElement;
let root: Root;
const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => body });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  apiFetch.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it('returns to the published library entry without a preview route or an entry write', async () => {
  apiFetch.mockResolvedValue(response({}, false));
  await act(() => root.render(<MemorySettingsContent />));
  const link = [...container.querySelectorAll('a')].find((item) => item.textContent?.trim() === '返回资料库 ↗');
  expect(link?.getAttribute('href')).toBe('/memory?tab=library');
  expect(apiFetch.mock.calls.every((args: unknown[]) => args.length === 1)).toBe(true);
});
it('a denied index status is unavailable, never a healthy report from the response body', async () => {
  apiFetch.mockImplementation((path: string) =>
    Promise.resolve(
      response(path.endsWith('env-summary') ? { variables: [] } : { backend: 'sqlite', healthy: true }, false),
    ),
  );
  await act(() => root.render(<IndexStatus />));
  expect(container.textContent).toContain('暂时读不到索引状态');
  expect(container.textContent).not.toContain('健康');
});
it('unknown recall modes remain unavailable rather than being translated as off', async () => {
  apiFetch.mockResolvedValue(response({ f200: { consumptionRerank: 'future-mode' } }));
  await act(() => root.render(<MemoryFlagPanel />));
  expect(container.textContent).toContain('暂时读不到召回功能标志');
  expect(container.textContent).not.toContain('关闭');
  expect(container.querySelector('button')?.textContent).toBe('重试');
});
it('recall flags recover through retry without providing a new writer', async () => {
  apiFetch
    .mockResolvedValueOnce(response({}, false))
    .mockResolvedValue(response({ f200: { consumptionRerank: 'shadow' } }));
  await act(() => root.render(<MemoryFlagPanel />));
  const retry = container.querySelector('button');
  expect(retry).not.toBeNull();
  await act(() => retry?.click());
  expect(container.textContent).toContain('影子模式');
  expect(
    apiFetch.mock.calls.every((args: unknown[]) => ((args[1] as RequestInit | undefined)?.method ?? 'GET') === 'GET'),
  ).toBe(true);
});
it('tool metrics use the session client and expose a denied read with retry, never zero', async () => {
  apiFetch.mockResolvedValue(response({}, false));
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('bare fetch must not run')));
  await act(() => root.render(<ToolUsageMetricsPanel />));
  expect(apiFetch).toHaveBeenCalledWith('/api/library/tool-usage-metrics');
  expect(container.textContent).toContain('暂时读不到工具使用指标');
  expect(container.querySelector('button')?.textContent).toBe('重试');
  expect(container.textContent).not.toContain('0.0');
});
it('the migrated service reader distinguishes denied from an empty service list', async () => {
  apiFetch.mockResolvedValue(response({ services: [] }, false));
  await act(() => root.render(<ServiceStatusPanel showReadState />));
  expect(container.textContent).toContain('暂时读不到服务状态');
  expect(container.textContent).not.toContain('没有匹配的服务');
  const retry = container.querySelector('button');
  expect(retry).not.toBeNull();
  apiFetch.mockResolvedValue(response({ services: [] }));
  await act(() => retry?.click());
  expect(container.textContent).toContain('没有匹配的服务');
});
it('index toggles preserve PATCH payloads and report refused writes', async () => {
  apiFetch.mockImplementation((path: string, init?: { method: string }) => {
    if (init?.method === 'PATCH') return Promise.resolve(response({ error: 'Forbidden' }, false));
    return Promise.resolve(
      response(
        path.endsWith('env-summary')
          ? {
              variables: [
                {
                  name: 'F200_CONSUMPTION_RERANK',
                  category: 'evidence',
                  defaultValue: 'off',
                  currentValue: 'off',
                  description: '消费重排序',
                  sensitive: false,
                  runtimeEditable: true,
                  allowedValues: ['off', 'shadow', 'on'],
                },
              ],
            }
          : { backend: 'sqlite', healthy: true },
      ),
    );
  });
  await act(() => root.render(<IndexStatus />));
  const toggle = container.querySelector('#evidence-feature-flags button');
  expect(toggle).not.toBeNull();
  await act(() => (toggle as HTMLButtonElement)?.click());
  const write = apiFetch.mock.calls.find((args: unknown[]) => args[0] === '/api/config/env');
  expect(JSON.parse(write?.[1].body)).toEqual({ updates: [{ name: 'F200_CONSUMPTION_RERANK', value: 'shadow' }] });
  expect(container.textContent).toContain('没能更新这个开关');
  expect(container.textContent).toContain('没有权限');
  expect(toggle?.textContent).toBe('off');
});
it('a successful runtime-editable index toggle refreshes the colocated effective recall mode', async () => {
  let mode = 'off';
  apiFetch.mockImplementation((path: string, init?: { body: string; method: string }) => {
    if (init?.method === 'PATCH') {
      mode = JSON.parse(init.body).updates[0].value;
      return Promise.resolve(response({ ok: true }));
    }
    const bodies: Record<string, unknown> = {
      '/api/recall/flags': { f200: { consumptionRerank: mode } },
      '/api/services': { services: [] },
      '/api/evidence/status': { backend: 'sqlite', healthy: true },
      '/api/config/env-summary': {
        variables: [
          {
            name: 'F200_CONSUMPTION_RERANK',
            category: 'evidence',
            defaultValue: 'off',
            currentValue: mode,
            description: '消费重排序',
            sensitive: false,
            runtimeEditable: true,
            allowedValues: ['off', 'shadow', 'on'],
          },
        ],
      },
    };
    return Promise.resolve(path in bodies ? response(bodies[path]) : response({}, false));
  });
  await act(() => root.render(<MemorySettingsContent />));
  expect(container.querySelector('[data-testid="f200-rerank-badge"]')?.textContent).toBe('关闭');
  await act(() => (container.querySelector('#evidence-feature-flags button') as HTMLButtonElement)?.click());
  expect(container.querySelector('[data-testid="f200-rerank-badge"]')?.textContent).toBe('影子模式');
});
