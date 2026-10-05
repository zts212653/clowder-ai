import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/stores/conciergeDesktopStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/conciergeDesktopStore')>()),
  showConciergeDesktop: vi.fn(async () => true),
  refreshConciergeDesktop: vi.fn(async () => true),
}));

import { showConciergeDesktop } from '@/stores/conciergeDesktopStore';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { ConciergeToolbar } from '../ConciergeToolbar';

const plugin = {
  catalogId: 'companion',
  availableVersion: '0.1.0-alpha.2',
  packageDigest: 'sha512-reviewed',
  effectiveGrants: ['windows.create'],
  instance: null,
};
const installed = {
  ...plugin,
  instance: {
    pluginInstanceId: 'pi-companion',
    activationState: 'disabled',
    runtimeState: 'stopped',
    lifecycleRevision: 2,
  },
};
let root: Root;
let container: HTMLDivElement;
const fetchMock = vi.mocked(apiFetch);
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
async function click(text: string) {
  const target = button(text);
  expect(target, `missing button ${text}`).toBeDefined();
  await act(async () => {
    target?.click();
  });
}
async function enter() {
  await act(async () => root.render(<ConciergeToolbar />));
  await click('聊聊');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useConciergeStore.setState({ surfaceState: 'toolbar', displayName: '猫猫球' });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('offers the official desktop from the existing chat entry; only explicit confirmation installs and opens', async () => {
  fetchMock.mockImplementation(async (path, init) => {
    if (!init?.method) return ok({ plugins: [plugin] });
    if (String(path).endsWith('/install')) return ok(installed);
    return ok({
      ...installed,
      instance: { ...installed.instance, activationState: 'enabled', runtimeState: 'healthy' },
    });
  });
  await enter();
  expect(document.body.textContent).toContain('安装并打开');
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  await click('安装并打开');
  const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.map(([path]) => path)).toEqual([
    '/api/plugins/official/companion/install',
    '/api/plugins/official/pi-companion/enable',
  ]);
  expect(JSON.parse(String(writes[0][1]?.body))).toEqual({
    expectedCatalogVersion: '0.1.0-alpha.2',
    expectedPackageDigest: 'sha512-reviewed',
  });
  expect(JSON.parse(String(writes[1][1]?.body))).toEqual({ expectedRevision: 2 });
  expect(showConciergeDesktop).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/live'))).toBe(false);
});

it('opens the existing healthy desktop without reinstalling, enabling, or changing preferences', async () => {
  fetchMock.mockImplementation(() =>
    ok({
      plugins: [
        {
          ...installed,
          instance: {
            ...installed.instance,
            activationState: 'enabled',
            runtimeState: 'healthy',
          },
        },
      ],
    }),
  );
  await enter();
  expect(showConciergeDesktop).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('does not continue to enable when the person leaves during installation', async () => {
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation((path, init) => {
    if (!init?.method) return ok({ plugins: [plugin] });
    if (String(path).endsWith('/install'))
      return new Promise((resolve) => {
        finish = resolve;
      });
    return ok(installed);
  });
  await enter();
  await click('安装并打开');
  await click('先用文字');
  await act(async () => finish(new Response(JSON.stringify(installed))));
  expect(useConciergeStore.getState().surfaceState).toBe('bubble');
  expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/enable'))).toBe(false);
  expect(showConciergeDesktop).not.toHaveBeenCalled();
});

it('retries showing a healthy desktop without repairing or mutating the installed plugin', async () => {
  vi.mocked(showConciergeDesktop).mockResolvedValueOnce(false).mockResolvedValue(true);
  fetchMock.mockImplementation(() =>
    ok({
      plugins: [
        {
          ...installed,
          instance: {
            ...installed.instance,
            activationState: 'enabled',
            runtimeState: 'healthy',
          },
        },
      ],
    }),
  );
  await enter();
  await click('打开桌面');
  expect(showConciergeDesktop).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('keeps install errors actionable and preserves the ordinary conversation escape route', async () => {
  fetchMock.mockImplementation((_path, init) =>
    init?.method
      ? Promise.resolve(new Response(JSON.stringify({ code: 'HOST_COMPONENT_UNAVAILABLE' }), { status: 422 }))
      : ok({ plugins: [plugin] }),
  );
  await enter();
  await click('安装并打开');
  expect(document.body.textContent).toContain('桌面组件');
  expect(button('重试')).toBeDefined();
  expect(showConciergeDesktop).not.toHaveBeenCalled();
  await click('先用文字');
  expect(useConciergeStore.getState().surfaceState).toBe('bubble');
});
