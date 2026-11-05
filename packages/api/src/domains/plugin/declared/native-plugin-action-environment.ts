import { createHash } from 'node:crypto';

/** Host references for durable MCP configuration; selected values are supplied per invocation. */
export function nativePluginActionEnvironmentKey(instanceId: string, contributionId: string, field: 'TOKEN' | 'PATH') {
  const id = createHash('sha256')
    .update(JSON.stringify([instanceId, contributionId]))
    .digest('hex')
    .toUpperCase();
  return `CLOWDER_PLUGIN_${id}_ACTION_${field}`;
}

/** These Host-owned lookup references are not ACP process identity or provider credentials. */
export function isNativePluginActionEnvironmentKey(key: string): boolean {
  return /^CLOWDER_PLUGIN_[A-F0-9]{64}_ACTION_(?:TOKEN|PATH)$/.test(key);
}
