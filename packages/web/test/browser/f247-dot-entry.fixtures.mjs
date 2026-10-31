// These are deterministic UI contract fixtures; provider subscription and image
// bytes are independently checked by f247-dot-mcp.test.ts and real dogfood.
export const personalProState = {
  pluginId: 'personal-chrome-host',
  channel: 'developer_preview',
  platform: 'darwin',
  platformSupport: 'supported',
  artifact: { helper: 'absent', extension: 'chrome_web_store' },
  distribution: { channel: 'chrome_web_store', integration: 'ready', publication: 'unavailable' },
  config: { status: 'absent' },
  authorization: { status: 'empty', count: 0, limit: 4, conversations: [] },
  intent: { status: 'developer_preview' },
  live: { status: 'dormant' },
};
export function managerDot(installed, enabled, verified = false, paired = false) {
  return {
    pluginId: 'official.chatgpt-dot',
    pluginInstanceId: installed ? 'pi_dot' : null,
    displayName: 'ChatGPT 云端',
    description: '在原对话召唤同一只 dot，接收回复和原图。',
    publisher: 'Clowder AI',
    source: { kind: 'catalog', catalogId: 'chatgpt-dot', packageName: '@cat-cafe/chatgpt-dot', trust: 'official' },
    availableVersion: '0.1.0',
    installedVersion: installed ? '0.1.0' : null,
    packageDigest: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
    artifact: installed ? 'installed' : 'absent',
    config: verified ? 'ready' : 'incomplete',
    auth: paired ? 'connected' : 'disconnected',
    intent: enabled ? 'enabled' : 'disabled',
    live: enabled ? 'running' : 'stopped',
    lifecycleRevision: installed ? 1 : null,
    capabilitySummary: [],
    actions: {
      install: !installed,
      setEnabled: installed && (enabled || verified),
      uninstall: installed,
      blockingReasons: verified ? [] : ['config-incomplete', 'auth-disconnected'],
    },
  };
}
