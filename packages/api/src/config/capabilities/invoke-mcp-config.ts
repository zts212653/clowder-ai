import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilitiesConfig } from '@cat-cafe/shared';
import { isSameCapabilityRoot } from './invoke-capability-root.js';

function read(root: string): CapabilitiesConfig | null {
  try {
    const value = JSON.parse(readFileSync(join(root, '.cat-cafe/capabilities.json'), 'utf8'));
    return (value?.version === 1 || value?.version === 2) &&
      Array.isArray(value.capabilities) &&
      // Match readCapabilitiesConfigState: every consumer reads fields off each entry.
      value.capabilities.every((entry: unknown) => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the existing project/global discovery configuration. Registered ${ENV}
 * mappings supersede copied literal values, so old project snapshots can use
 * runtime-only credentials without a write/sync pass. Project access policy,
 * overrides and literal settings retain their existing semantics.
 */
export function readInvocationMcpConfig(
  globalRoot: string,
  projectRoot?: string,
): {
  config: CapabilitiesConfig | null;
  configSourceRoot: string;
  accessScope: 'global' | 'project';
} {
  const registered = read(globalRoot);
  const project = projectRoot && !isSameCapabilityRoot(projectRoot, globalRoot) ? read(projectRoot) : null;
  if (!project) return { config: registered, configSourceRoot: globalRoot, accessScope: 'global' };
  if (!registered) return { config: project, configSourceRoot: projectRoot!, accessScope: 'project' };
  const definitions = new Map(
    registered.capabilities.filter((entry) => entry.type === 'mcp').map((entry) => [entry.id, entry]),
  );
  return {
    configSourceRoot: projectRoot!,
    accessScope: 'project',
    config: {
      ...project,
      capabilities: project.capabilities.map((entry) => {
        if (entry.type !== 'mcp') return entry;
        const current = definitions.get(entry.id);
        if (!current?.mcpServer?.env || !entry.mcpServer) return entry;
        const references = Object.fromEntries(
          Object.entries(current.mcpServer.env).filter(([, value]) => /\$\{[^}]+\}/.test(value)),
        );
        return {
          ...entry,
          mcpServer: { ...entry.mcpServer, env: { ...entry.mcpServer.env, ...references } },
        };
      }),
    },
  };
}
