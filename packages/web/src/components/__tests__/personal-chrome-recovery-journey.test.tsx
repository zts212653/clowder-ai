import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { personalChromeSettingsHref } from '@/utils/personal-chrome-settings';
import { CloudBindingRecoveryCard } from '../CloudBindingRecoveryCard';
import { CloudConversationLink } from '../CloudConversationLink';
import { PluginsContent } from '../settings/PluginsContent';
import { packageRows } from './cloud-route-test-fixtures';

const fetch = vi.mocked(apiFetch);
const container = document.createElement('div');
let root = createRoot(container);
const pluginId = 'official.companion.personal-chrome';
const local = `/api/plugin-manager/plugins/_local/${pluginId}`;
const base = `/api/plugins/${pluginId}/actions/personalChromeAuthorizations/`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const candidate = { conversationId: 'retained-conversation', displayTitle: '原有授权' };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  act(() => root.unmount());
  root = createRoot(container);
  vi.resetAllMocks();
  window.history.replaceState({}, '', '/');
});
afterAll(() => {
  act(() => root.unmount());
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function serve({ installed = true, enabled = true, reload = false, authorized = true } = {}) {
  fetch.mockImplementation(async (path) => {
    if (path === local)
      return installed
        ? json({
            plugin: {
              pluginId,
              artifact: 'installed',
              intent: enabled ? 'enabled' : 'disabled',
              live: enabled ? 'running' : 'stopped',
            },
          })
        : json({ error: 'not found' }, 404);
    if (path === `${base}list`)
      return installed
        ? json(packageRows(authorized ? [candidate] : []))
        : json({ error: `Plugin '${pluginId}' is not installed` }, 404);
    if (path === `${base}status`)
      return json({
        ok: true,
        render: 'status',
        data: { helper: { state: 'connected' }, delivery: { reloadRequired: reload } },
      });
    if (String(path).endsWith('/cloud-bindings'))
      return json({ bindings: {}, cloudCat: { status: 'resolved', catId: 'gpt-pro' } });
    return json({}, 404);
  });
}

async function renderBoth() {
  await act(async () => {
    root.render(
      <>
        <CloudBindingRecoveryCard
          threadId="thread-one"
          sourceMessageId="source-one"
          targetCatId="gpt-pro"
          attemptId="attempt-one"
        />
        <CloudConversationLink threadId="thread-one" />
      </>,
    );
  });
}

it('missing package opens its real Manager installation from both the original message and thread chooser', async () => {
  serve({ installed: false });
  await renderBoth();
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll('a')]
        .map((link) => link.getAttribute('href'))
        .filter((href) => href === personalChromeSettingsHref()),
    ).toHaveLength(2),
  );
  expect(container.textContent).toContain('安装 Personal Chrome');
  expect(container.textContent).not.toContain("Plugin '");
  expect(container.querySelector('[data-recovery-primary]')).toBeNull();
  expect(fetch.mock.calls.some(([path]) => String(path).endsWith('/install') || String(path).endsWith('/retry'))).toBe(
    false,
  );
});

it('disabled settings keep existing authorizations visible, but require explicit enable before sending', async () => {
  serve({ enabled: false });
  await renderBoth();
  await vi.waitFor(() => expect(container.textContent).toContain('启用 Personal Chrome'));
  expect(container.textContent).toContain('原有授权');
  expect(container.querySelector<HTMLButtonElement>('[data-recovery-primary]')?.disabled).toBe(true);
  expect(container.textContent).not.toContain('已发送到 ChatGPT');
  expect(
    fetch.mock.calls.some(([path]) => String(path).endsWith('/set-enabled') || String(path).endsWith('/retry')),
  ).toBe(false);
});

it('extension not ready with no authorizations offers connection setup before asking for authorization', async () => {
  serve({ reload: true, authorized: false });
  await renderBoth();
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll('a')]
        .map((link) => link.getAttribute('href'))
        .filter((href) => href === personalChromeSettingsHref()),
    ).toHaveLength(2),
  );
  expect(container.textContent).toContain('重载');
  expect(container.querySelector('[data-recovery-open-chatgpt]')).toBeNull();
  expect(container.textContent).not.toContain('还没有已授权');
});

it('healthy empty setup asks for explicit conversation authorization and refresh, without binding anything', async () => {
  serve({ authorized: false });
  await renderBoth();
  await vi.waitFor(() => expect(container.querySelector('[data-recovery-open-chatgpt]')).not.toBeNull());
  expect(container.textContent).toContain('授权此会话');
  expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
});

it('opens the current installed package from the retained Pro settings bookmark', async () => {
  window.history.replaceState({}, '', '/settings?s=plugins#personal-chatgpt-pro');
  const plugin = {
    pluginId,
    displayName: 'Personal Chrome Companion',
    source: {
      kind: 'catalog',
      catalogId: 'personal-chrome-companion',
      packageName: '@clowder-ai/personal-chrome-companion',
      trust: 'official',
    },
    artifact: 'installed',
    config: 'ready',
    auth: 'connected',
    intent: 'enabled',
    live: 'running',
    installedVersion: '0.1.0-alpha.6',
    availableVersion: '0.1.0-alpha.6',
    packageDigest: 'sha512-fixture',
    lifecycleRevision: 1,
    capabilitySummary: [],
    configFields: [],
    capabilities: [],
    contributions: [],
    actions: { install: false, setEnabled: true, uninstall: true, blockingReasons: [] },
  };
  fetch.mockImplementation(async (path) => {
    if (path === '/api/plugin-manager/plugins') return json({ plugins: [plugin], catalog: { status: 'fresh' } });
    if (path === `/api/plugin-manager/plugins/${pluginId}`) return json({ plugin, catalog: { status: 'fresh' } });
    return json({}, 404);
  });
  await act(async () => root.render(<PluginsContent />));
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="plugin-manager-detail"]')?.textContent).toContain(
      'Personal Chrome Companion',
    ),
  );
  expect(fetch.mock.calls.some(([path]) => String(path).includes('/personal-chrome-host'))).toBe(false);
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
