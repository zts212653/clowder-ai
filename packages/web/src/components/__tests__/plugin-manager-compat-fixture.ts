import type { PluginManagerDetail } from '@cat-cafe/shared';

export const catalog = { status: 'fresh', refreshedAt: 1 };
export const github: PluginManagerDetail = {
  pluginId: 'github',
  pluginInstanceId: 'pi_github',
  displayName: 'GitHub',
  source: {
    kind: 'compatibility',
    adapter: 'repository-local',
    packageName: 'repository-local:github',
    trust: 'first-party',
  },
  artifact: 'installed',
  config: 'ready',
  auth: 'not-required',
  intent: 'disabled',
  live: 'stopped',
  installedVersion: '1.0.0',
  availableVersion: null,
  packageDigest: null,
  lifecycleRevision: 1,
  capabilitySummary: [],
  capabilities: [],
  actions: { install: false, uninstall: false, setEnabled: true, blockingReasons: [] },
  configFields: [
    {
      key: 'GITHUB_TOKEN',
      label: 'Personal Access Token',
      kind: 'secret',
      required: false,
      sensitive: true,
      currentValue: null,
    },
    {
      key: 'GITHUB_SETUP_NOISE_BOT_LOGINS',
      label: 'Noise Bot Login List',
      kind: 'string',
      required: false,
      sensitive: false,
      currentValue: 'chatgpt-codex-connector[bot]',
    },
  ],
};
export function managerResponse(path: string, plugin: PluginManagerDetail = github): Response {
  if (path === '/api/plugin-manager/plugins') return jsonResponse({ plugins: [plugin], catalog });
  if (path === `/api/plugin-manager/plugins/${plugin.pluginId}`) return jsonResponse({ plugin, catalog });
  return jsonResponse({}, 404);
}
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
