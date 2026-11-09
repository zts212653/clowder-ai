const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'] as const;

/** Process-local exclusions for ordinary Codex shared HTTP MCP, after account overlays. */
export function codexLoopbackProxyEnvironment(
  overrides: Readonly<Record<string, string | null | undefined>>,
  inherited: Readonly<NodeJS.ProcessEnv> = process.env,
): { NO_PROXY: string; no_proxy: string } {
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const list of [
    ...(['NO_PROXY', 'no_proxy'] as const).map((key) =>
      Object.hasOwn(overrides, key) ? overrides[key] : inherited[key],
    ),
    ...LOOPBACK_HOSTS,
  ]) {
    for (const entry of (list ?? '').split(',')) {
      const host = entry.trim();
      if (!host || seen.has(host.toLowerCase())) continue;
      seen.add(host.toLowerCase());
      hosts.push(host);
    }
  }
  // Clients differ in which spelling wins. Neither may shadow the other's exclusions.
  const value = hosts.join(',');
  return { NO_PROXY: value, no_proxy: value };
}
