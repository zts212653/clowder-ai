import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useSettingsBindings } from '../useSettingsBindings';
import { act, cleanup, renderHook } from './hook-host';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
});

it('pushes audit and marketplace receipts, writes only the user source and reads confirmed sources after mutations', async () => {
  const sources = [
    {
      id: 'source',
      url: 'https://plugins.test/repo',
      branch: 'stable',
      commit: 'owner-commit',
      origin: 'user',
      status: 'ready',
    },
  ];
  const audit = {
    entries: [
      {
        timestamp: 'now',
        capabilityId: 'skill',
        action: 'enable',
        userId: 'owner',
        before: null,
        after: { type: 'skill' },
      },
    ],
  };
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    Response.json(path.startsWith('/api/capabilities/audit') ? audit : { sources }),
  );
  const { result } = renderHook(useSettingsBindings);
  await act(() => result.current.action('settingsCapAuditRead', { projectPath: '/project' }));
  expect(result.current.data.audit).toEqual(audit);
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/capabilities/audit?limit=50&projectPath=%2Fproject',
    undefined,
    undefined,
  );
  await act(() => result.current.action('settingsMarketRead', {}));
  await act(() =>
    result.current.action('settingsMarketWrite', {
      op: 'add',
      value: JSON.stringify({ url: sources[0].url, branch: 'stable' }),
    }),
  );
  await act(() => result.current.action('settingsMarketWrite', { op: 'refresh' }));
  await act(() => result.current.action('settingsMarketWrite', { op: 'delete', id: 'source' }));
  const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method);
  expect(writes.map(([path, init]) => [path, init?.method, JSON.parse(String(init?.body))])).toEqual([
    ['/api/plugin-manager/marketplaces', 'POST', { url: sources[0].url, branch: 'stable' }],
    ['/api/plugin-manager/marketplaces/refresh', 'POST', {}],
    ['/api/plugin-manager/marketplaces/source', 'DELETE', {}],
  ]);
  expect(result.current.data.marketSources).toEqual({ sources });
  const reads = vi.mocked(apiFetch).mock.calls.length;
  expect(apiFetch).toHaveBeenCalledTimes(reads);
});

it('uses the hooks owner and actual draft account, client and model; preserves skipped connectivity as skipped', async () => {
  const hooks = { status: 'missing', targets: [{ name: 'Codex', reason: 'missing file' }] };
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    Response.json(path.includes('connectivity-test') ? { ok: true, skipped: true, message: 'No CLI probe' } : hooks),
  );
  const { result } = renderHook(useSettingsBindings);
  await act(() => result.current.action('settingsHooksRead', {}));
  await act(() => result.current.action('settingsHooksSync', {}));
  await act(() =>
    result.current.action('settingsMemberConnection', {
      key: 'openai:owner:model',
      value: JSON.stringify({ profileId: 'owner', clientId: 'openai', model: 'model' }),
    }),
  );
  expect(result.current.data.hooks).toEqual(hooks);
  expect(result.current.data.connections['openai:owner:model']).toMatchObject({ ok: true, skipped: true });
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/agent-hooks/sync',
    expect.objectContaining({ method: 'POST', body: '{}' }),
    undefined,
  );
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/first-run/connectivity-test',
    expect.objectContaining({ body: '{"profileId":"owner","clientId":"openai","model":"model"}' }),
    undefined,
  );
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({ error: 'account_unavailable' }, { status: 404 }));
  await act(() =>
    result.current.action('settingsMemberConnection', {
      key: 'openai:owner:model',
      value: '{"profileId":"owner","clientId":"openai","model":"model"}',
    }),
  );
  expect(result.current.data.connections['openai:owner:model']).toEqual({ ok: false, error: 'account_unavailable' });
});

it('keeps page-action authority from the owner through page selection, inspection, consent and revocation', async () => {
  let owner: object = {
    kind: 'available',
    requestMessageId: 'request-real',
    requestText: 'Read this page',
    pageSelection: true,
    state: 'ready',
  };
  const writes: { path: string; method: string; body: unknown }[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method) {
      writes.push({ path, method: init.method, body: JSON.parse(String(init.body)) });
      if (path.endsWith('/pages'))
        return Response.json({ pages: [{ pageId: 'page-real', title: 'Owner page', url: 'https://page.test/' }] });
      owner = {
        kind: 'available',
        requestMessageId: 'request-real',
        pageSelection: true,
        state: 'awaiting_consent',
        preview: { previewId: 'preview-real' },
      };
    }
    return Response.json(owner);
  });
  const { result } = renderHook(useSettingsBindings);
  await act(() => result.current.action('settingsPageActionRead', {}));
  expect(result.current.data.pageActionPages[0].pageId).toBe('page-real');
  await act(() => result.current.action('settingsPageAction', { op: 'select', pageId: 'page-real' }));
  await act(() => result.current.action('settingsPageAction', { op: 'inspect' }));
  await act(() => result.current.action('settingsPageAction', { op: 'confirm', previewId: 'preview-real' }));
  await act(() => result.current.action('settingsPageAction', { op: 'revoke', previewId: 'preview-real' }));
  expect(writes).toEqual([
    { path: '/api/concierge/page-action/pages', method: 'POST', body: { requestMessageId: 'request-real' } },
    {
      path: '/api/concierge/page-action/select',
      method: 'POST',
      body: { requestMessageId: 'request-real', pageId: 'page-real' },
    },
    { path: '/api/concierge/page-action/inspect', method: 'POST', body: { requestMessageId: 'request-real' } },
    { path: '/api/concierge/page-action/confirm', method: 'POST', body: { previewId: 'preview-real' } },
    { path: '/api/concierge/page-action', method: 'DELETE', body: { previewId: 'preview-real' } },
  ]);
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({ error: 'preview_stale' }, { status: 409 }));
  await act(() => result.current.action('settingsPageAction', { op: 'confirm', previewId: 'preview-real' }));
  expect(result.current.data.pageActionError).toBe('preview_stale');
  expect(result.current.data.pageAction).toEqual(owner);
});

it('disconnects only the confirmed binding, saves permission CAS and resets the declared operation', async () => {
  let revision = 4;
  const writes: { path: string; method: string; body: unknown }[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (init?.method) {
      writes.push({ path, method: init.method, body: JSON.parse(String(init.body)) });
      revision++;
      return Response.json({ ok: true });
    }
    if (path === '/api/plugin-manager/plugins')
      return Response.json({ plugins: [{ pluginId: 'plugin', lifecycleRevision: revision }] });
    if (path === '/api/plugin-manager/pdl') return Response.json({ fragments: {} });
    if (path.endsWith('/documentation')) return Response.json({});
    if (path.endsWith('/contributions/tools')) return Response.json({ tools: [] });
    if (path.endsWith('/permissions'))
      return Response.json({
        revision,
        whitelistEnabled: true,
        commandAdminOnly: false,
        adminOpenIds: [],
        allowedGroups: [],
      });
    return Response.json({
      plugin: {
        pluginId: 'plugin',
        lifecycleRevision: revision,
        artifact: 'installed',
        configFields: [],
        permissions: { label: 'Owner permissions' },
      },
    });
  });
  const { result } = renderHook(useSettingsBindings);
  await act(() => result.current.action('settingsPluginsRead', {}));
  await act(() => result.current.action('settingsPluginDetailRead', { id: 'plugin' }));
  await act(() =>
    result.current.action('settingsPluginDisconnect', {
      id: 'plugin',
      key: 'binding',
      threadId: 'thread',
      createdAt: '77',
    }),
  );
  await act(() =>
    result.current.action('settingsPluginPermissionsSave', {
      id: 'plugin',
      value: JSON.stringify({ expectedRevision: 5, whitelistEnabled: false }),
    }),
  );
  await act(() => result.current.action('settingsPcfReset', { id: 'plugin', field: 'login' }));
  expect(writes).toEqual([
    {
      path: '/api/plugin-manager/plugins/plugin/bindings/disconnect',
      method: 'POST',
      body: { key: 'binding', threadId: 'thread', createdAt: 77, confirmed: true },
    },
    {
      path: '/api/plugin-manager/plugins/plugin/permissions',
      method: 'PUT',
      body: { expectedRevision: 5, whitelistEnabled: false },
    },
    { path: '/api/plugins/plugin/operations/login/reset', method: 'POST', body: {} },
  ]);
  expect(result.current.data.pluginDetails.plugin.lifecycleRevision).toBe(7);
});
