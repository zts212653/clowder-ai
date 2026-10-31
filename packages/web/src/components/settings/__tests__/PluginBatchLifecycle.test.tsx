import type { PluginManagerListItem } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { PluginManagerContent } from '../plugin-manager/PluginManagerContent';
import {
  batchResultText,
  batchResultTitle,
  type PluginBatchResult,
  pluginBatchEntry,
} from '../plugin-manager/plugin-batch-model';
import { runPluginBatch } from '../plugin-manager/plugin-batch-runner';
import { designFixture } from '../plugin-manager/plugin-manager-live-api';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);
const fresh: PluginManagerListItem = {
  pluginId: 'first',
  pluginInstanceId: 'original',
  displayName: 'First',
  source: { kind: 'unknown', packageName: null, trust: 'unknown' },
  artifact: 'installed',
  installedVersion: '1',
  availableVersion: '2',
  packageDigest: 'original-digest',
  config: 'ready',
  auth: 'not-required',
  intent: 'enabled',
  live: 'crashed',
  lifecycleRevision: 9,
  capabilitySummary: [],
  actions: { install: true, repair: true, setEnabled: true, uninstall: true, blockingReasons: [] },
};
const reply = (plugin = fresh) =>
  new Response(JSON.stringify({ plugin, catalog: { status: 'fresh', refreshedAt: 1 } }), { status: 200 });
const entry = (plugin = fresh) => pluginBatchEntry(designFixture(plugin, undefined, { state: 'absent' }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it('updates a broken plugin exactly once with its freshly read revision and reports a failed restart honestly', async () => {
  const results: PluginBatchResult[] = [];
  api
    .mockResolvedValueOnce(reply())
    .mockResolvedValueOnce(new Response('{}'))
    .mockResolvedValueOnce(reply({ ...fresh, installedVersion: '2', lifecycleRevision: 12 }));
  await runPluginBatch([entry()], { active: () => true, onResult: (r) => results.push(r), onChanged: async () => {} });
  expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(api.mock.calls[1][0]).toBe('/api/plugin-manager/plugins/first/update');
  expect(JSON.parse(String(api.mock.calls[1][1]?.body))).toEqual({ expectedRevision: 9, expectedVersion: '2' });
  expect(batchResultText(results.at(-1)!)).toBe('已更新到 2，但启动还是出错');
  expect(results.at(-1)?.repairAllowed).toBe(true);
});

it('does not silently replace a reinstalled instance or retry an uncertain mutation', async () => {
  api.mockResolvedValueOnce(reply({ ...fresh, pluginInstanceId: 'another' }));
  const results: PluginBatchResult[] = [];
  await runPluginBatch([entry()], { active: () => true, onResult: (r) => results.push(r), onChanged: async () => {} });
  expect(results.at(-1)?.state).toBe('skipped');
  expect(api).toHaveBeenCalledTimes(1);
  api.mockReset();
  results.length = 0;
  api.mockResolvedValueOnce(reply()).mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(reply());
  await runPluginBatch([entry()], { active: () => true, onResult: (r) => results.push(r), onChanged: async () => {} });
  expect(results.at(-1)?.state).toBe('unknown');
  expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('keeps a disabled updated plugin disabled instead of enabling or repairing it', async () => {
  const plugin = { ...fresh, intent: 'disabled' as const };
  const results: PluginBatchResult[] = [];
  api
    .mockResolvedValueOnce(reply(plugin))
    .mockResolvedValueOnce(new Response('{}'))
    .mockResolvedValueOnce(reply({ ...plugin, installedVersion: '2', live: 'stopped' }));
  await runPluginBatch([entry(plugin)], {
    active: () => true,
    onResult: (r) => results.push(r),
    onChanged: async () => {},
  });
  expect(results.at(-1)).toMatchObject({ state: 'updated', disabled: true });
  expect(batchResultText(results.at(-1)!)).toBe('已更新到 2');
  expect(api).toHaveBeenCalledTimes(3);
});

it('stops subsequent items when Settings unmounts while the first server operation is in flight', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let finish!: (r: Response) => void;
  const operation = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  api.mockImplementation(async (path, init) => (init?.method === 'POST' ? operation : reply()));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <PluginManagerContent
        presentation="v2"
        fixtures={[
          entry().plugin,
          entry({ ...fresh, pluginId: 'second', pluginInstanceId: 'second-instance', displayName: 'Second' }).plugin,
        ]}
      />,
    ),
  );
  const button = (text: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text))!;
  await act(async () => button('一起处理…').click());
  await act(async () => button('开始处理 2 个').click());
  expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  act(() => root.unmount());
  await act(async () => {
    finish(new Response('{}'));
    await operation;
  });
  expect(api.mock.calls.some(([path]) => String(path).includes('/second'))).toBe(false);
  expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  container.remove();
});

it('rechecks configuration and cancellation after a slow fresh read before sending any mutation', async () => {
  const results: PluginBatchResult[] = [];
  api.mockResolvedValueOnce(
    reply({ ...fresh, config: 'incomplete', actions: { ...fresh.actions, blockingReasons: ['config-incomplete'] } }),
  );
  await runPluginBatch([entry()], { active: () => true, onResult: (r) => results.push(r), onChanged: async () => {} });
  expect(results.at(-1)?.state).toBe('skipped');
  expect(api.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  api.mockReset();
  let active = true;
  api.mockImplementationOnce(async () => {
    active = false;
    return reply();
  });
  await runPluginBatch([entry()], { active: () => active, onResult: () => {}, onChanged: async () => {} });
  expect(api).toHaveBeenCalledTimes(1);
});

it('stops later items without aborting an already received operation', async () => {
  let active = true;
  const results: PluginBatchResult[] = [];
  api
    .mockResolvedValueOnce(reply())
    .mockImplementationOnce(async () => {
      active = false;
      return new Response('{}');
    })
    .mockResolvedValueOnce(reply({ ...fresh, installedVersion: '2', live: 'running' }));
  await runPluginBatch([entry(), entry({ ...fresh, pluginId: 'second' })], {
    active: () => active,
    onResult: (r) => results.push(r),
    onChanged: async () => {},
  });
  expect(results.at(-1)).toMatchObject({ state: 'updated', live: 'running' });
  expect(api.mock.calls.some(([path]) => String(path).includes('/second'))).toBe(false);
  expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('keeps each batch row in place until closing, then restores the actual list and mobile list view', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<PluginManagerContent presentation="v2" fixtures={[entry().plugin]} />));
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;
  await act(async () => button('一起处理…').click());
  await act(async () =>
    root.render(
      <PluginManagerContent
        presentation="v2"
        fixtures={[
          entry({
            ...fresh,
            installedVersion: '2',
            live: 'running',
            actions: { ...fresh.actions, install: false, repair: false },
          }).plugin,
        ]}
      />,
    ),
  );
  const frozenRow = container.querySelector('[data-plugin-section="attention"] [data-plugin-id="first"]');
  expect(frozenRow).not.toBeNull();
  const frozenAction = frozenRow!.querySelector<HTMLButtonElement>('[data-plugin-primary-action="update"]');
  expect(frozenAction?.textContent).toBe('更新');
  expect(frozenAction?.disabled).toBe(true);
  expect(frozenRow!.querySelector<HTMLButtonElement>('[aria-pressed]')?.disabled).toBe(true);
  await act(async () => button('取消').click());
  expect(container.querySelector('[data-plugin-section="attention"]')).toBeNull();
  expect(container.querySelector('[data-plugin-section="installed"] [data-plugin-id="first"]')).not.toBeNull();
  expect(container.querySelector('[data-mobile-panel="list"]')?.className).not.toContain('hidden');
  act(() => root.unmount());
  container.remove();
});

it('locks row controls without claiming queued or completed rows are working', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const plugins = [
    fresh,
    { ...fresh, pluginId: 'second', displayName: 'Second', actions: { ...fresh.actions, repair: false } },
    { ...fresh, pluginId: 'setup', displayName: 'Setup', config: 'incomplete' as const },
  ];
  const installed = new Set<string>();
  let finish!: () => void;
  const received = new Promise<void>((resolve) => {
    finish = resolve;
  });
  api.mockImplementation(async (path, init) => {
    const plugin = plugins.find((p) => String(path).split('/')[4] === p.pluginId)!;
    if (init?.method === 'POST') {
      if (plugin.pluginId === 'first') await received;
      installed.add(plugin.pluginId);
      return new Response('{}');
    }
    return reply(installed.has(plugin.pluginId) ? { ...plugin, installedVersion: '2', live: 'running' } : plugin);
  });
  const onRepair = vi.fn(),
    onInstall = vi.fn(),
    onSetEnabled = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;
  const labels = (working = false) => {
    for (const [id, label] of [
      ['first', working ? '处理中…' : '修复'],
      ['second', '更新'],
      ['setup', '去填写'],
    ]) {
      const row = container.querySelector(`[data-mobile-panel="list"] [data-plugin-id="${id}"]`)!;
      const primary = row.querySelector<HTMLButtonElement>('[data-plugin-primary-action]');
      expect(primary?.textContent).toBe(label);
      expect(primary?.disabled).toBe(true);
      primary?.click();
      const toggle = row.querySelector<HTMLButtonElement>('[aria-pressed]');
      expect(toggle?.disabled).toBe(true);
      toggle?.click();
    }
    expect(onInstall).not.toHaveBeenCalled();
    expect(onRepair).not.toHaveBeenCalled();
    expect(onSetEnabled).not.toHaveBeenCalled();
  };
  try {
    await act(async () =>
      root.render(
        <PluginManagerContent
          presentation="v2"
          fixtures={plugins.map((p) => entry(p).plugin)}
          onInstall={onInstall}
          onRepair={onRepair}
          onSetEnabled={onSetEnabled}
        />,
      ),
    );
    await act(async () => button('一起处理…').click());
    labels();
    await act(async () => button('开始处理 2 个').click());
    labels(true);
    expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    await act(async () => {
      finish();
      await received;
    });
    expect(container.querySelector('[data-batch-phase="results"]')).not.toBeNull();
    labels();
    expect(api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    await act(async () => button('好了').click());
    expect(container.querySelector<HTMLButtonElement>('[data-plugin-primary-action="repair"]')?.disabled).toBe(false);
  } finally {
    finish();
    act(() => root.unmount());
    container.remove();
  }
});

it.each(['starting', 'handshaking'] as const)('reports %s as pending instead of a failed restart', (live) => {
  const result: PluginBatchResult = { id: 'first', state: 'updated', version: '2', live, disabled: false };
  expect(batchResultText(result)).toContain('结果待确认');
  expect(batchResultText(result)).not.toContain('出错');
  expect(batchResultTitle([result])).toContain('1 个结果待确认');
  expect(batchResultTitle([result])).not.toContain('仍有问题');
});
