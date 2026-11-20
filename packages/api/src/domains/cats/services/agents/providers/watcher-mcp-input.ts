import { CANONICAL_TOOL_REGISTRY } from '@cat-cafe/mcp-server/dist/canonical-server-tools.js';
import type { CodexMcpInputPlan } from './codex-mcp-input.js';
import type { ProviderMcpConfigPlan } from './provider-mcp-config.js';

function watcherFamilies(names: readonly string[]): Set<string> {
  if (names.length === 0) throw new Error('watcher_tool_surface_unavailable');
  return new Set(
    names.map((name) => {
      const tool = CANONICAL_TOOL_REGISTRY.find((tool) => tool.name === name);
      if (!tool) throw new Error(`watcher_tool_unavailable:${name}`);
      return `cat-cafe-${tool.serverFamily}`;
    }),
  );
}

export function watcherMcpToolAllowed(name: string, names: readonly string[]): boolean {
  const match = /^mcp__(cat-cafe-[A-Za-z0-9_-]+)__(cat_cafe_[a-z0-9_]+)$/.exec(name);
  if (!match || !names.includes(match[2])) return false;
  const tool = CANONICAL_TOOL_REGISTRY.find((tool) => tool.name === match[2]);
  return Boolean(tool && match[1] === `cat-cafe-${tool.serverFamily}`);
}

/** The hook and process surfaces share registry-derived family/name pairs. */
export function watcherMcpToolMap(names: readonly string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const family of watcherFamilies(names)) result[family] = [];
  for (const name of names) {
    const tool = CANONICAL_TOOL_REGISTRY.find((entry) => entry.name === name);
    if (!tool) throw new Error(`watcher_tool_unavailable:${name}`);
    result[`cat-cafe-${tool.serverFamily}`].push(name);
  }
  return result;
}

/** No plugin, external server or unselected Café family enters a watcher process. */
export function watcherMcpInput(plan: CodexMcpInputPlan, names: readonly string[]): CodexMcpInputPlan {
  if (!plan.available || names.length === 0) throw new Error('watcher_tool_surface_unavailable');
  const families = watcherFamilies(names);
  const servers = plan.servers.filter((server) => server.catCafe && server.enabled && families.has(server.name));
  if (servers.length !== families.size) throw new Error('watcher_tool_family_unavailable');
  return { ...plan, servers };
}

/** Provider discovery proves built-in ownership before credentials are materialized. */
export function watcherNativeMcpPlan(plan: ProviderMcpConfigPlan, names: readonly string[]): ProviderMcpConfigPlan {
  const selected = [...watcherFamilies(names)];
  const servers = Object.fromEntries(
    selected.map((name) => {
      const server = plan.servers[name];
      if (!plan.catCafeMcpServerNames.includes(name) || !server || typeof server.command !== 'string' || server.url)
        throw new Error('watcher_tool_family_unavailable');
      return [
        name,
        {
          ...server,
          env: {
            ...(server.env as Record<string, string> | undefined),
            CAT_CAFE_WATCHER_TOOL_NAMES: '',
            CAT_CAFE_ALLOWED_TOOL_NAMES: JSON.stringify(names),
          },
        },
      ];
    }),
  );
  return { ...plan, servers, catCafeMcpServerNames: selected, pluginMcpServerNames: [] };
}
