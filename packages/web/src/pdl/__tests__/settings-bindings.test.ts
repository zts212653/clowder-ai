import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useSettingsBindings } from '../useSettingsBindings';
import { act, cleanup, renderHook } from './hook-host';
import { createOwnerConsole } from './owner-console';
import { settingsInput, systemSummaryFixture } from './owner-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('reads package documentation with its detail and contribution tools only when requested by the projection', async () => {
  const plugin = {
      pluginId: 'fixture.plugin',
      artifact: 'installed',
      intent: 'enabled',
      live: 'running',
      configFields: [],
    },
    documentation = { readmeMarkdown: '# Package body' },
    tools = [{ contributionId: 'mcp.fixture', name: 'fixture_tool', inputSchema: {} }];
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path.endsWith('/documentation')) return Response.json(documentation);
    if (path.endsWith('/contributions/tools')) return Response.json({ tools });
    return Response.json({ plugin });
  });
  const { result } = renderHook(useSettingsBindings);
  expect(apiFetch).not.toHaveBeenCalled();
  await act(() => result.current.action('settingsPluginDetailRead', { id: 'fixture.plugin' }));
  expect(result.current.data.pluginDetails['fixture.plugin']).toEqual(plugin);
  expect(result.current.data.pluginDocumentation['fixture.plugin']).toEqual(documentation);
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual([
    '/api/plugin-manager/plugins/fixture.plugin',
    '/api/plugin-manager/plugins/fixture.plugin/documentation',
  ]);
  await act(() => result.current.action('settingsPluginToolsRead', { id: 'fixture.plugin' }));
  expect(result.current.data.pluginTools['fixture.plugin']).toEqual(tools);
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual([
    '/api/plugin-manager/plugins/fixture.plugin',
    '/api/plugin-manager/plugins/fixture.plugin/documentation',
    '/api/plugin-manager/plugins/fixture.plugin/contributions/tools',
  ]);
});

it('reads inactive package details without requesting active-runtime contributions', async () => {
  const plugin = {
    pluginId: 'fixture.inactive',
    artifact: 'installed',
    intent: 'disabled',
    live: 'stopped',
    configFields: [],
  };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path.endsWith('/contributions/tools'))
      return Response.json({ error: 'fixture.inactive is not active' }, { status: 409 });
    if (path.endsWith('/documentation')) return Response.json({ readmeMarkdown: '# Inactive package' });
    return Response.json({ plugin });
  });
  const { result } = renderHook(useSettingsBindings);
  expect(apiFetch).not.toHaveBeenCalled();
  await act(() => result.current.action('settingsPluginDetailRead', { id: plugin.pluginId }));
  expect(result.current.data.pluginDetails[plugin.pluginId]).toEqual(plugin);
  expect(result.current.data.pluginDocumentation[plugin.pluginId]).toEqual({ readmeMarkdown: '# Inactive package' });
  expect(vi.mocked(apiFetch).mock.calls.map(([path]) => path)).toEqual([
    '/api/plugin-manager/plugins/fixture.inactive',
    '/api/plugin-manager/plugins/fixture.inactive/documentation',
  ]);
});

it('holds environment owner receipts, sends only the edited value and keeps the confirmed data on rejection', async () => {
  const summary = {
    categories: { server: 'Server' },
    variables: [
      {
        name: 'API_PORT',
        description: 'API port',
        defaultValue: '3000',
        category: 'server',
        sensitive: false,
        currentValue: '3013',
        runtimeEditable: true,
        restartRequired: true,
      },
    ],
  };
  vi.mocked(apiFetch).mockImplementation(async () => Response.json(summary));
  const { result } = renderHook(useSettingsBindings);
  expect(apiFetch).not.toHaveBeenCalled();
  await act(() => result.current.action('settingsEnvRead', {}));
  expect(result.current.data.env).toEqual(summary);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  const variables = [{ ...summary.variables[0], currentValue: '3014' }];
  vi.mocked(apiFetch).mockImplementation(async () => Response.json({ summary: variables }));
  await act(() => result.current.action('settingsEnvSave', { key: 'API_PORT', value: '3014' }));
  expect(apiFetch).toHaveBeenLastCalledWith(
    '/api/config/env',
    expect.objectContaining({ method: 'PATCH', body: '{"updates":[{"name":"API_PORT","value":"3014"}]}' }),
    undefined,
  );
  expect(result.current.data.env?.variables).toEqual(variables);
  expect(result.current.data.envPending).toEqual(['API_PORT']);
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({ error: 'Owner rejected env write' }, { status: 403 }),
  );
  await expect(result.current.action('settingsEnvSave', { key: 'API_PORT', value: '3015' })).rejects.toThrow(
    'Owner rejected env write',
  );
  expect(result.current.data.env?.variables).toEqual(variables);
});

it('reads the system summary only on demand and merges repeated configuration receipts by variable name', async () => {
  let summary = systemSummaryFixture();
  vi.mocked(apiFetch).mockImplementation(async () => Response.json(summary));
  const { result } = renderHook(useSettingsBindings);
  expect(apiFetch).not.toHaveBeenCalled();
  await act(() => result.current.action('settingsSystemRead', {}));
  expect(apiFetch).toHaveBeenCalledWith('/api/config/env-summary?surface=system', undefined, undefined);
  expect(result.current.data.system).toEqual(summary);
  const console = createOwnerConsole({
    sources: { settings: { ...settingsInput(), system: result.current.data.system } },
  });
  const before = console.read('projectData("settings").system.variables');
  summary = {
    ...summary,
    variables: summary.variables.map((variable) =>
      variable.name === 'API_SERVER_PORT' ? { ...variable, currentValue: '4015' } : variable,
    ),
  };
  await act(() => result.current.action('settingsSystemRead', {}));
  const diff = console.push({ settings: { ...settingsInput(), system: result.current.data.system } });
  const after = console.read('projectData("settings").system.variables');
  expect(diff.settings.changed).toEqual(['API_SERVER_PORT']);
  expect(after[0].currentValue).toBe('4015');
  expect(after[1]).toBe(before[1]);
  expect(after.find((variable: { name: string }) => variable.name === 'MESSAGE_TTL_SECONDS')).toMatchObject({
    currentValue: '604800',
    runtimeEditable: false,
    restartRequired: true,
  });
});

it('reads the actual Codex and Claude account selections without saving a member or committing a global account switch', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    Response.json({
      selection: { state: 'selected', accountRef: path.includes('codex') ? 'codex-current' : 'claude-current' },
    }),
  );
  const { result } = renderHook(useSettingsBindings);
  await act(() => result.current.action('settingsFollowRead', { clientId: 'openai' }));
  await act(() => result.current.action('settingsFollowRead', { clientId: 'anthropic' }));
  expect(result.current.data.follows).toEqual({
    openai: { state: 'selected', accountRef: 'codex-current' },
    anthropic: { state: 'selected', accountRef: 'claude-current' },
  });
  expect(vi.mocked(apiFetch).mock.calls.map(([path, init]) => [path, init])).toEqual([
    ['/api/accounts/codex/members', undefined],
    ['/api/accounts/claude/members', undefined],
  ]);
});

it('installs the reviewed package quote and pushes the acknowledged list without enabling the plugin', async () => {
  const body = {
      source: { kind: 'catalog', catalogId: 'fixture.catalog' },
      expectedVersion: '1.2.3',
      expectedDigest: 'sha512-fixture',
    },
    receipt = {
      plugins: [{ pluginId: 'fixture.plugin', artifact: 'installed', intent: 'disabled' }],
      catalog: { status: 'fresh', refreshedAt: 1 },
    };
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    Response.json(path.endsWith('/install') ? { ok: true } : receipt),
  );
  const { result } = renderHook(useSettingsBindings);
  await act(() => result.current.action('settingsPluginInstall', { value: JSON.stringify(body) }));
  const calls = vi.mocked(apiFetch).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0][0]).toBe('/api/plugin-manager/plugins/install');
  expect(calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify(body) });
  expect(calls[1][0]).toBe('/api/plugin-manager/plugins');
  expect(result.current.data.plugins).toEqual(receipt);
  vi.mocked(apiFetch).mockImplementation(async () =>
    Response.json({ error: 'Catalog quote changed' }, { status: 409 }),
  );
  await expect(result.current.action('settingsPluginInstall', { value: JSON.stringify(body) })).rejects.toThrow(
    'Catalog quote changed',
  );
  expect(result.current.data.plugins).toEqual(receipt);
});

it('opens external URLs through the host platform action with the prototype window policy', async () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const { result } = renderHook(useSettingsBindings);
  await act(() => result.current.action('platform:openUrl', { url: 'https://example.test/evidence' }));
  expect(open).toHaveBeenCalledWith('https://example.test/evidence', '_blank', 'noopener,noreferrer');
});

it('restarts the installed plugin through repair with the displayed lifecycle revision and keeps the receipt after rejection', async () => {
  const plugin = { pluginId: 'fixture.restart', artifact: 'installed', lifecycleRevision: 7, configFields: [] };
  let reject = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path.endsWith('/repair')) {
      expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ expectedRevision: 7 }) });
      return reject ? Response.json({ error: 'revision_changed' }, { status: 409 }) : Response.json({ ok: true });
    }
    if (path.endsWith('/pdl')) return Response.json({ fragments: {} });
    if (path.endsWith('/documentation')) return Response.json({ readmeMarkdown: '' });
    if (path.endsWith('/contributions/tools')) return Response.json({ tools: [] });
    return Response.json(path.endsWith('/plugins') ? { plugins: [plugin] } : { plugin });
  });
  const { result } = renderHook(useSettingsBindings);
  await act(() => result.current.action('settingsPluginsRead', {}));
  await act(() => result.current.action('settingsPluginRestart', { id: plugin.pluginId }));
  expect(result.current.data.pluginDetails[plugin.pluginId]).toEqual(plugin);
  reject = true;
  await expect(result.current.action('settingsPluginRestart', { id: plugin.pluginId })).rejects.toThrow(
    'revision_changed',
  );
  expect(result.current.data.pluginDetails[plugin.pluginId]).toEqual(plugin);
});
