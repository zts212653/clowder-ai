import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilitiesConfig } from '@cat-cafe/shared';
import { isSameCapabilityRoot } from './invoke-capability-root.js';

const sourceReads = new AsyncLocalStorage<{ versions: Map<string, string | null>; changed: boolean }>();

/** Async native readers report the actual bytes they parsed, including an absent optional layer. */
export function observeInvocationMcpSource(path: string, raw: string | null): void {
  const state = sourceReads.getStore();
  if (!state) return;
  const version = raw === null ? null : createHash('sha256').update(raw).digest('hex');
  const previous = state.versions.get(path);
  if (previous !== undefined && previous !== version) state.changed = true;
  else state.versions.set(path, version);
}

/** Preserve filesystem errors so each client keeps its existing required/optional-file policy. */
export function readInvocationMcpFile(path: string): string {
  let raw: string | null = null;
  try {
    raw = readFileSync(path, 'utf8');
    return raw;
  } finally {
    observeInvocationMcpSource(path, raw);
  }
}

function readSource(path: string) {
  try {
    const raw = readFileSync(path, 'utf8');
    return { raw, version: createHash('sha256').update(raw).digest('hex') };
  } catch {
    return { raw: null, version: null };
  }
}

/** Track only versions during this admission. Each read still uses its existing source and parsing policy. */
export async function captureInvocationMcpSources<T>(capture: () => T | Promise<T>) {
  const state = { versions: new Map<string, string | null>(), changed: false };
  const value = await sourceReads.run(state, capture);
  return {
    value,
    isCurrent: () =>
      !state.changed && [...state.versions].every(([path, version]) => readSource(path).version === version),
  };
}

function read(root: string): CapabilitiesConfig | null {
  const path = join(root, '.cat-cafe/capabilities.json');
  const { raw } = readSource(path);
  observeInvocationMcpSource(path, raw);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
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
