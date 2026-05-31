import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type {
  CapabilitiesConfig,
  CapabilityEntry,
  ILimbNode,
  PluginManifest,
  PluginResourceDef,
} from '@cat-cafe/shared';
import type { LimbRegistry } from '../limb/LimbRegistry.js';
import { normalizeCapId, resolvePluginResourcePath, resourceCapId, resourcePathBasename } from './PluginRegistry.js';
import { resolvePluginEnv } from './plugin-config-store.js';

const PROVIDER_DIRS = ['.claude/skills', '.codex/skills', '.gemini/skills', '.kimi/skills'];

export interface ActivationResult {
  type: string;
  path?: string;
  name?: string;
  ok: boolean;
  error?: string;
}

export interface ActivatePluginResult {
  status: 'success' | 'partial' | 'failed';
  resources: ActivationResult[];
}

export type LimbAdapterFactory = (pluginId: string, limbYamlPath: string) => Promise<ILimbNode>;

export interface PluginResourceActivatorDeps {
  resolveProjectRoot: () => string;
  pluginsDir: string;
  limbRegistry: LimbRegistry;
  readCapabilities: () => Promise<CapabilitiesConfig | null>;
  writeCapabilities: (config: CapabilitiesConfig) => Promise<void>;
  withCapabilityLock: <T>(fn: () => Promise<T>) => Promise<T>;
  limbAdapterFactory?: LimbAdapterFactory;
}

export function withPersistedLimbNodeId<T extends ILimbNode>(node: T, persistedNodeId?: string): T {
  if (!persistedNodeId || persistedNodeId === node.nodeId) return node;

  const descriptor = Object.getOwnPropertyDescriptor(node, 'nodeId');
  Object.defineProperty(node, 'nodeId', {
    value: persistedNodeId,
    enumerable: descriptor?.enumerable ?? true,
    configurable: descriptor?.configurable ?? true,
    writable: descriptor && 'writable' in descriptor ? descriptor.writable : true,
  });
  return node;
}

export async function assertPluginResourceInsideRoot(
  pluginsDir: string,
  manifest: PluginManifest,
  resourcePath: string,
  label: string,
): Promise<void> {
  const pluginRoot = join(pluginsDir, manifest.id);
  const [pluginRootReal, resourceReal] = await Promise.all([realpath(pluginRoot), realpath(resourcePath)]);
  const rel = relative(pluginRootReal, resourceReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} must resolve inside plugin root ${pluginRootReal}: ${resourceReal}`);
  }
}

export interface PluginLimbRehydrationDeps {
  capabilities: CapabilitiesConfig | null;
  pluginRegistry: Pick<import('./PluginRegistry.js').PluginRegistry, 'getManifest'>;
  pluginsDir: string;
  limbAdapterRegistry: Map<string, (yamlPath: string) => Promise<ILimbNode>>;
  limbRegistry: Pick<LimbRegistry, 'register'>;
  log?: Pick<Console, 'info' | 'warn'>;
}

export async function rehydrateEnabledPluginLimbs(deps: PluginLimbRehydrationDeps): Promise<void> {
  if (!deps.capabilities) return;

  const enabledLimbs = deps.capabilities.capabilities.filter((c) => c.type === 'limb' && c.enabled && c.pluginId);
  for (const cap of enabledLimbs) {
    const manifest = deps.pluginRegistry.getManifest(cap.pluginId!);
    if (!manifest) continue;
    const normalizedCapId = normalizeCapId(cap.id);
    const limbResource = manifest.resources.find(
      (r) => r.type === 'limb' && resourceCapId(manifest.id, r) === normalizedCapId,
    );
    if (!limbResource?.path) continue;
    const factory = deps.limbAdapterRegistry.get(manifest.id);
    if (!factory) {
      deps.log?.info(`[api] F202: Skipping limb rehydration for '${manifest.id}' (no adapter registered)`);
      continue;
    }
    try {
      const yamlPath = resolvePluginResourcePath(deps.pluginsDir, manifest.id, limbResource.path);
      await assertPluginResourceInsideRoot(deps.pluginsDir, manifest, yamlPath, 'Limb resource');
      const node = withPersistedLimbNodeId(await factory(yamlPath), cap.limbNodeId);
      await deps.limbRegistry.register(node);
      deps.log?.info(`[api] F202: Rehydrated limb for plugin '${manifest.id}'`);
    } catch (err) {
      deps.log?.warn(`[api] F202: Failed to rehydrate limb for plugin '${manifest.id}': ${(err as Error).message}`);
    }
  }
}

export class PluginResourceActivator {
  private readonly deps: PluginResourceActivatorDeps;

  constructor(deps: PluginResourceActivatorDeps) {
    this.deps = deps;
  }

  async enablePlugin(manifest: PluginManifest): Promise<ActivatePluginResult> {
    const results: ActivationResult[] = [];

    for (const resource of manifest.resources) {
      try {
        await this.activateResource(manifest, resource);
        results.push({ type: resource.type, path: resource.path, name: resource.name, ok: true });
      } catch (err) {
        results.push({
          type: resource.type,
          path: resource.path,
          name: resource.name,
          ok: false,
          error: (err as Error).message,
        });
      }
    }

    const allOk = results.every((r) => r.ok);
    const someOk = results.some((r) => r.ok);
    return {
      status: allOk ? 'success' : someOk ? 'partial' : 'failed',
      resources: results,
    };
  }

  async disablePlugin(manifest: PluginManifest): Promise<ActivatePluginResult> {
    const results: ActivationResult[] = [];
    const declaredIds = new Set(manifest.resources.map((resource) => resourceCapId(manifest.id, resource)));

    for (const resource of manifest.resources) {
      try {
        await this.deactivateResource(manifest, resource);
        results.push({ type: resource.type, path: resource.path, name: resource.name, ok: true });
      } catch (err) {
        results.push({
          type: resource.type,
          path: resource.path,
          name: resource.name,
          ok: false,
          error: (err as Error).message,
        });
      }
    }

    try {
      await this.removeOrphanedPluginEntries(manifest, declaredIds);
    } catch (err) {
      results.push({ type: 'orphan', ok: false, error: (err as Error).message });
    }

    const allOk = results.every((r) => r.ok);
    const someOk = results.some((r) => r.ok);
    return {
      status: allOk ? 'success' : someOk ? 'partial' : 'failed',
      resources: results,
    };
  }

  private async activateResource(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    switch (resource.type) {
      case 'skill':
        await this.activateSkill(manifest, resource);
        break;
      case 'limb':
        await this.activateLimb(manifest, resource);
        break;
      case 'mcp':
        await this.activateMcp(manifest, resource);
        break;
      default:
        throw new Error(`Unsupported resource type: ${resource.type}`);
    }
  }

  private async deactivateResource(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    switch (resource.type) {
      case 'skill':
        await this.deactivateSkill(manifest, resource);
        break;
      case 'limb':
        await this.deactivateLimb(manifest, resource);
        break;
      case 'mcp':
        await this.deactivateMcp(manifest, resource);
        break;
      default:
        throw new Error(`Unsupported resource type: ${resource.type}`);
    }
  }

  private async activateSkill(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.path) throw new Error('Skill resource must have a path');

    const skillSourceDir = resolvePluginResourcePath(this.deps.pluginsDir, manifest.id, resource.path);
    if (!existsSync(skillSourceDir)) {
      throw new Error(`Skill source not found: ${skillSourceDir}`);
    }
    await assertPluginResourceInsideRoot(this.deps.pluginsDir, manifest, skillSourceDir, 'Skill resource');
    const skillStat = await stat(skillSourceDir);
    if (!skillStat.isDirectory()) {
      throw new Error(`Skill resource must be a directory: ${skillSourceDir}`);
    }
    const skillMdPath = join(skillSourceDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
      throw new Error(`Skill resource directory must contain SKILL.md: ${skillSourceDir}`);
    }
    const skillName = resourcePathBasename(resource.path);

    const createdLinks: string[] = [];
    try {
      for (const providerDir of PROVIDER_DIRS) {
        const skillsDir = join(this.deps.resolveProjectRoot(), providerDir);
        if (await this.shouldSkipDirectoryLevelSkillsSymlink(skillsDir, dirname(skillSourceDir))) continue;
        await mkdir(skillsDir, { recursive: true });
        const linkPath = join(skillsDir, skillName);
        if (await this.ensureSymlink(linkPath, skillSourceDir)) createdLinks.push(linkPath);
      }
      await this.upsertCapabilityEntry(manifest, resource, true);
    } catch (err) {
      for (const linkPath of createdLinks) {
        await this.removeOwnedSymlink(linkPath, skillSourceDir);
      }
      throw err;
    }
  }

  private async deactivateSkill(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.path) return;

    const skillSourceDir = resolvePluginResourcePath(this.deps.pluginsDir, manifest.id, resource.path);
    const skillName = resourcePathBasename(resource.path);

    for (const providerDir of PROVIDER_DIRS) {
      const linkPath = join(this.deps.resolveProjectRoot(), providerDir, skillName);
      await this.removeOwnedSymlink(linkPath, skillSourceDir);
    }

    await this.upsertCapabilityEntry(manifest, resource, false);
  }

  private async activateLimb(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.path) throw new Error('Limb resource must have a path');
    if (!this.deps.limbAdapterFactory) {
      throw new Error('No limb adapter factory configured');
    }

    const yamlPath = resolvePluginResourcePath(this.deps.pluginsDir, manifest.id, resource.path);
    await assertPluginResourceInsideRoot(this.deps.pluginsDir, manifest, yamlPath, 'Limb resource');
    const node = await this.deps.limbAdapterFactory(manifest.id, yamlPath);
    const previous = await this.upsertCapabilityEntry(manifest, resource, true, node.nodeId);
    const capId = resourceCapId(manifest.id, resource);
    const previousEntry = previous?.capabilities.find(
      (c) => normalizeCapId(c.id) === capId && c.pluginId === manifest.id,
    );
    const previousNodeId = previousEntry?.limbNodeId;
    try {
      await this.deps.limbRegistry.register(node);
      // Deregister stale node when re-enabling with a different nodeId
      if (previousNodeId && previousNodeId !== node.nodeId) {
        this.deps.limbRegistry.deregister(previousNodeId);
      }
    } catch (err) {
      await this.rollbackCapabilityEntry(manifest, resource, previousEntry);
      throw err;
    }
  }

  private async deactivateLimb(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.path) return;

    const removedEntries = await this.removeCapabilityEntry(manifest, resource);
    const ownedEntry = removedEntries.find((c) => c.type === 'limb' && c.pluginId === manifest.id && c.enabled);
    const nodeId = ownedEntry?.limbNodeId;

    if (nodeId) {
      this.deps.limbRegistry.deregister(nodeId);
    }
  }

  private async activateMcp(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (resource.transport && resource.transport !== 'stdio' && resource.transport !== 'streamableHttp') {
      throw new Error(`Unsupported MCP transport '${resource.transport}'`);
    }
    if (resource.transport === 'streamableHttp' && !resource.url) {
      throw new Error('MCP streamableHttp resource must declare a url');
    }
    if (resource.transport !== 'streamableHttp' && !resource.command) {
      throw new Error('MCP resource must declare a command');
    }
    await this.upsertCapabilityEntry(manifest, resource, true);
  }

  private async deactivateMcp(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    // First disable: triggers CLI config regeneration which tells writers to delete the entry.
    // If we only removeCapabilityEntry, the row vanishes before generateCliConfigs runs,
    // so the CLI writer never sees the disabled server and leaves stale config behind.
    await this.upsertCapabilityEntry(manifest, resource, false);
    await this.removeCapabilityEntry(manifest, resource);
  }

  private async upsertCapabilityEntry(
    manifest: PluginManifest,
    resource: PluginResourceDef,
    enabled: boolean,
    limbNodeId?: string,
  ): Promise<CapabilitiesConfig | null> {
    return this.deps.withCapabilityLock(async () => {
      const config = await this.deps.readCapabilities();
      const previous = config ? structuredClone(config) : null;
      const cap: CapabilitiesConfig = config ? structuredClone(config) : { version: 1, capabilities: [] };
      const capId = resourceCapId(manifest.id, resource);

      let staleLimbNodeIdToClean: string | undefined;
      const existing = cap.capabilities.find((c) => normalizeCapId(c.id) === capId);
      if (existing) {
        if (existing.pluginId !== undefined && existing.pluginId !== manifest.id) {
          throw new Error(`Capability '${capId}' is already owned by plugin '${existing.pluginId}'`);
        }
        if (existing.pluginId === undefined) {
          throw new Error(`Capability '${capId}' exists as a non-plugin entry and cannot be claimed`);
        }

        // When transitioning away from MCP, first write a disabled MCP entry so CLI
        // config writers see the disabled descriptor and delete the stale server config.
        if (existing.type === 'mcp' && resource.type !== 'mcp' && existing.enabled) {
          existing.enabled = false;
          await this.writeCapabilitiesWithRollback(previous, structuredClone(cap));
        }

        // Capture stale limb nodeId before type transition so we can deregister after write
        const staleLimbNodeId =
          existing.type === 'limb' && resource.type !== 'limb' && existing.enabled ? existing.limbNodeId : undefined;

        existing.type = resource.type as 'mcp' | 'skill' | 'limb';
        existing.enabled = enabled;
        existing.pluginId = manifest.id;
        if (resource.type === 'mcp') {
          delete existing.limbNodeId;
          existing.mcpServer = this.buildMcpServer(manifest, resource);
        } else {
          delete existing.mcpServer;
          if (resource.type === 'limb' && limbNodeId !== undefined) {
            existing.limbNodeId = limbNodeId;
          } else {
            delete existing.limbNodeId;
          }
        }
        // staleLimbNodeId is deregistered after the write below
        staleLimbNodeIdToClean = staleLimbNodeId;
      } else {
        const entry: CapabilityEntry = {
          id: capId,
          type: resource.type as 'mcp' | 'skill' | 'limb',
          enabled,
          source: 'cat-cafe',
          pluginId: manifest.id,
          ...(limbNodeId ? { limbNodeId } : {}),
        };

        if (resource.type === 'mcp') {
          entry.mcpServer = this.buildMcpServer(manifest, resource);
        }

        cap.capabilities.push(entry);
      }

      await this.writeCapabilitiesWithRollback(previous, cap);

      // Deregister stale limb node only after config write succeeds
      if (staleLimbNodeIdToClean) {
        try {
          this.deps.limbRegistry.deregister(staleLimbNodeIdToClean);
        } catch {
          /* best-effort: node may already be gone */
        }
      }
      return previous;
    });
  }

  private async removeCapabilityEntry(
    manifest: PluginManifest,
    resource: PluginResourceDef,
  ): Promise<CapabilityEntry[]> {
    return this.deps.withCapabilityLock(async () => {
      const config = await this.deps.readCapabilities();
      if (!config) return [];
      const previous = structuredClone(config);
      const next = structuredClone(config);

      const capId = resourceCapId(manifest.id, resource);
      const removedEntries = next.capabilities.filter(
        (c) => normalizeCapId(c.id) === capId && c.pluginId === manifest.id,
      );
      next.capabilities = next.capabilities.filter(
        (c) => !(normalizeCapId(c.id) === capId && c.pluginId === manifest.id),
      );
      await this.writeCapabilitiesWithRollback(previous, next);
      return removedEntries;
    });
  }

  private async removeOrphanedPluginEntries(manifest: PluginManifest, declaredIds: Set<string>): Promise<void> {
    const limbNodeIds: string[] = [];
    await this.deps.withCapabilityLock(async () => {
      const config = await this.deps.readCapabilities();
      if (!config) return;
      const isOrphan = (c: CapabilityEntry) => c.pluginId === manifest.id && !declaredIds.has(normalizeCapId(c.id));
      const orphaned = config.capabilities.filter(isOrphan);
      if (orphaned.length === 0) return;

      // Phase 1: disable orphaned MCP entries so CLI config writers see the disabled
      // descriptor and can delete the stale generated server entries.
      const hasMcpOrphans = orphaned.some((c) => c.type === 'mcp' && c.enabled);
      if (hasMcpOrphans) {
        const disableSnap = structuredClone(config);
        const disableNext = structuredClone(config);
        for (const cap of disableNext.capabilities) {
          if (isOrphan(cap) && cap.type === 'mcp' && cap.enabled) {
            cap.enabled = false;
          }
        }
        await this.writeCapabilitiesWithRollback(disableSnap, disableNext);
      }

      // Phase 2: remove all orphaned entries.
      const freshConfig = await this.deps.readCapabilities();
      if (!freshConfig) return;
      const previous = structuredClone(freshConfig);
      const next = structuredClone(freshConfig);
      for (const cap of next.capabilities) {
        if (isOrphan(cap)) {
          if (cap.type === 'limb' && cap.enabled && cap.limbNodeId) {
            limbNodeIds.push(cap.limbNodeId);
          }
        }
      }
      next.capabilities = next.capabilities.filter((c) => !isOrphan(c));
      await this.writeCapabilitiesWithRollback(previous, next);
    });

    for (const nodeId of limbNodeIds) {
      this.deps.limbRegistry.deregister(nodeId);
    }
  }

  async syncPluginEnv(manifest: PluginManifest): Promise<void> {
    await this.deps.withCapabilityLock(async () => {
      const config = await this.deps.readCapabilities();
      if (!config) return;
      const previous = structuredClone(config);
      const next = structuredClone(config);

      const mcpEnv = this.buildMcpEnv(manifest);
      let changed = false;
      for (const cap of next.capabilities) {
        if (cap.pluginId !== manifest.id || cap.type !== 'mcp' || !cap.mcpServer) continue;
        cap.mcpServer.env = mcpEnv.env;
        changed = true;
      }
      if (changed) await this.writeCapabilitiesWithRollback(previous, next);
    });
  }

  private buildMcpServer(
    manifest: PluginManifest,
    resource: PluginResourceDef,
  ): NonNullable<CapabilityEntry['mcpServer']> {
    if (resource.transport === 'streamableHttp') {
      return {
        command: '',
        args: [],
        transport: 'streamableHttp',
        url: resource.url,
      };
    }

    return {
      command: resource.command!,
      args: resource.args ?? [],
      transport: (resource.transport as 'stdio' | 'streamableHttp') ?? 'stdio',
      workingDir: join(this.deps.pluginsDir, manifest.id),
      ...this.buildMcpEnv(manifest),
    };
  }

  private buildMcpEnv(manifest: PluginManifest): { env?: Record<string, string> } {
    if (manifest.config.length === 0) return {};
    const resolved = resolvePluginEnv([manifest]);
    const env: Record<string, string> = {};
    for (const field of manifest.config) {
      const val = resolved[field.envName];
      if (val) env[field.envName] = val;
    }
    return Object.keys(env).length > 0 ? { env } : {};
  }

  private async writeCapabilitiesWithRollback(
    previous: CapabilitiesConfig | null,
    next: CapabilitiesConfig,
  ): Promise<void> {
    try {
      await this.deps.writeCapabilities(next);
    } catch (err) {
      const rollback = previous ?? { version: 1, capabilities: [] };
      try {
        await this.deps.writeCapabilities(structuredClone(rollback));
      } catch {
        /* If regeneration fails after writing, the rollback write still restores persisted state. */
      }
      throw err;
    }
  }

  private async rollbackCapabilityEntry(
    manifest: PluginManifest,
    resource: PluginResourceDef,
    previousEntry?: CapabilityEntry,
  ): Promise<void> {
    try {
      await this.deps.withCapabilityLock(async () => {
        const config = await this.deps.readCapabilities();
        if (!config) return;
        const capId = resourceCapId(manifest.id, resource);
        if (previousEntry) {
          const idx = config.capabilities.findIndex(
            (c) => normalizeCapId(c.id) === capId && c.pluginId === manifest.id,
          );
          if (idx >= 0) config.capabilities[idx] = previousEntry;
        } else {
          config.capabilities = config.capabilities.filter(
            (c) => !(normalizeCapId(c.id) === capId && c.pluginId === manifest.id),
          );
        }
        await this.deps.writeCapabilities(config);
      });
    } catch {
      /* Preserve the original activation error; best-effort rollback already attempted. */
    }
  }

  private async shouldSkipDirectoryLevelSkillsSymlink(skillsDir: string, expectedRoot: string): Promise<boolean> {
    try {
      const stat = await lstat(skillsDir);
      if (!stat.isSymbolicLink()) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }

    let mountedRoot: string;
    let expectedRealRoot: string;
    try {
      mountedRoot = await realpath(skillsDir);
      expectedRealRoot = await realpath(expectedRoot);
    } catch (err) {
      throw new Error(
        `Invalid directory-level plugin skill mount at ${skillsDir}: symlink must resolve to ${expectedRoot}. ${
          (err as Error).message
        }`,
      );
    }

    if (mountedRoot !== expectedRealRoot) {
      throw new Error(
        `Refusing to mount plugin skill into directory-level skills symlink at ${skillsDir}: resolves to ${mountedRoot}, expected ${expectedRealRoot}`,
      );
    }

    return true;
  }

  private async ensureSymlink(linkPath: string, target: string): Promise<boolean> {
    try {
      const s = await lstat(linkPath);
      if (s.isSymbolicLink()) {
        const { readlink } = await import('node:fs/promises');
        const existing = await readlink(linkPath);
        if (existing === target) return false;
        throw new Error(`Refusing to overwrite existing symlink at ${linkPath} (current target: ${existing})`);
      } else {
        throw new Error(`Refusing to overwrite non-symlink at ${linkPath}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Refusing')) throw err;
    }
    await symlink(target, linkPath);
    return true;
  }

  private async removeOwnedSymlink(linkPath: string, expectedTarget: string): Promise<void> {
    try {
      const s = await lstat(linkPath);
      if (!s.isSymbolicLink()) return;
      const { readlink } = await import('node:fs/promises');
      const actual = await readlink(linkPath);
      if (actual !== expectedTarget) return;
      await rm(linkPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }
}
