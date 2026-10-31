export function resolvePluginManagerDesignGate(search: string, nodeEnv = process.env.NODE_ENV) {
  const params = new URLSearchParams(search);
  return {
    resolved: true,
    enabled: nodeEnv !== 'production' && params.get('pluginManagerDemo') === '1',
    live: params.get('pluginManagerLive') === '1',
    degradedCatalog: params.get('catalog') === 'degraded',
  };
}

export function usesFixedPluginManagerLayout(search: string, nodeEnv = process.env.NODE_ENV): boolean {
  return resolvePluginManagerDesignGate(search, nodeEnv).resolved;
}
