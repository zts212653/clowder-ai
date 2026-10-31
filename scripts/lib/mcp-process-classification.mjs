import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const carriers = [
  ['agy-native', /(?:antigravity|agy)[^ ]*(?: |$)/i],
  ['claude', /(?:^|[/ ])claude(?: |$|\/)/],
  ['codex', /(?:^|[/ ])codex(?: |$|\/)/],
  ['gemini', /(?:^|[/ ])gemini(?: |$|\/)/],
  ['kimi', /(?:^|[/ ])kimi(?: |$|\/)/],
  ['opencode', /(?:^|[/ ])opencode(?: |$|\/)/],
  ['acp', /(?:icode|acp-client|acp-stdio)/i],
];

const managedEntrypoint = /(?:^|\s)(\/[^\s]+\/mcp-package-v\d+)\/([^\s]+\.[cm]?js)(?:\s|$)/;
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Read only managed identity markers. A directory hash is never a plugin ID. */
export function loadManagedMcpPackages(rows) {
  const packages = new Map();
  for (const { command } of rows) {
    const root = managedEntrypoint.exec(command)?.[1];
    if (!root || packages.has(root)) continue;
    try {
      const marker = JSON.parse(readFileSync(join(root, '.clowder-mcp-resource.json'), 'utf8'));
      if (typeof marker.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(marker.pluginId)) continue;
      if (typeof marker.packageDigest !== 'string' || marker.packageDigest.length > 256) continue;
      if (basename(dirname(root)) !== hash(marker.packageDigest)) continue;
      if (basename(dirname(dirname(root))) !== hash(marker.pluginId)) continue;
      packages.set(root, { root, pluginId: marker.pluginId, packageDigest: marker.packageDigest });
    } catch {
      /* missing or invalid metadata remains explicitly unverified */
    }
  }
  return [...packages.values()];
}

export function classifyMcpProcess(command, managedPackages) {
  const builtin =
    /([^\s]+)\/packages\/mcp-server\/(?:dist|src)\/(secret-mcp-proxy|index|collab|memory|signals|limb|audio|finance|remote-spike|dot-remote-proxy)\.[cm]?[jt]s(?: |$)/.exec(
      command,
    );
  if (builtin)
    return {
      category: builtin[2] === 'secret-mcp-proxy' ? 'protection_proxy' : 'self_mcp',
      family: builtin[2] === 'secret-mcp-proxy' ? null : builtin[2],
      deploymentRoot: builtin[1],
    };
  const managed = managedEntrypoint.exec(command);
  if (managed) {
    const metadata = managedPackages.find((pkg) => pkg.root === managed[1]);
    return metadata
      ? {
          category: 'plugin_mcp',
          pluginId: metadata.pluginId,
          packageDigest: metadata.packageDigest,
          family: managed[2],
        }
      : { category: 'unverified_plugin_mcp' };
  }
  // Only label the exact observed F193 probe payload. This is census evidence,
  // not permission to terminate a process or retire arbitrary inline tools.
  const inlineModule = /(?:^|\s)--eval ([\s\S]+)$/.exec(command)?.[1];
  if (inlineModule && hash(inlineModule) === '3bfb1cdc8bdcca70024d5c19eaeef63bbbee241f7b38ef7ff9e5454922d0600c')
    return { category: 'external_mcp', family: 'f193-retired-probe' };
  if (
    /(?:Google Chrome(?: Helper)?(?:\.app)?|chrome-headless-shell|\/Chromium|\/firefox(?: |$)|ms-playwright\/.*(?:chrome|headless))/i.test(
      command,
    )
  )
    return { category: 'browser' };
  const named = [
    ['pencil', /pencil[^ ]*mcp/i],
    ['pinchtab', /pinchtab/i],
    ['agent-browser', /agent-browser/i],
    ['node_repl', /node[_-]repl/i],
    ['MCP_DOCKER', /docker[^\n]*mcp[^\n]*gateway/i],
    ['claude-in-chrome', /claude[^ ]*(?:in-chrome|chrome-mcp)/i],
    ['playwright', /(?:playwright\/cli\.js|server-playwright)/i],
    ['mcp-remote', /mcp-remote/i],
    ['chrome-devtools', /chrome-devtools-mcp/i],
  ].find(([, pattern]) => pattern.test(command));
  if (named) return { category: 'external_mcp', family: named[0] };
  if (/(?:mcp-server|server-(?:filesystem|memory|everything)|context7|fetch-mcp)/i.test(command))
    return { category: 'external_mcp' };
  if (carriers.some(([, pattern]) => pattern.test(command))) return { category: 'carrier' };
  if (/(?:^|[/ ])node(?: |$)/.test(command)) return { category: 'unknown_node' };
  return { category: 'other' };
}
