import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import {
  type CapabilitiesConfig,
  type CapabilityEntry,
  type ILimbNode,
  type PluginManifest,
  type PluginResourceDef,
  STANDARD_MOUNT_POINT_IDS,
} from '@cat-cafe/shared';
import {
  installMcpCapability,
  type McpConfigIO,
  removeMcpCapability,
} from '../../config/capabilities/capability-mcp-service.js';
import { readMountRules } from '../../config/mount/mount-rules-store.js';
import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import { mountSkillSymlinks, unmountSkillSymlinks } from '../../skills/skill-manage.js';
import { classifyMountPath } from '../../skills/skill-sync-engine.js';
import { buildSkillMountTargets, isManagedDirectoryLevelSkillsSymlink } from '../../utils/skill-mount.js';
import type { LimbRegistry } from '../limb/LimbRegistry.js';
import { normalizeCapId, resolvePluginResourcePath, resourceCapId, resourcePathBasename } from './PluginRegistry.js';
import { resolvePluginEnv } from './plugin-config-store.js';
import type { ScheduleFactoryDeps, ScheduleFactoryRegistry } from './ScheduleFactoryRegistry.js';

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

/** Minimal TaskRunner interface for schedule resource activation (F202 Phase 2) */
export interface ScheduleTaskRunner {
  /** Register a builtin task that may arrive after start() — does NOT mark as dynamic */
  registerPostStart(task: TaskSpec_P1): void;
  unregister(taskId: string): boolean;
}

export interface PluginResourceActivatorDeps {
  resolveProjectRoot: () => string;
  resolveMainProjectRoot?: () => string;
  pluginsDir: string;
  limbRegistry: LimbRegistry;
  readCapabilities: () => Promise<CapabilitiesConfig | null>;
  writeCapabilities: (config: CapabilitiesConfig) => Promise<void>;
  withCapabilityLock: <T>(fn: () => Promise<T>) => Promise<T>;
  limbAdapterFactory?: LimbAdapterFactory;
  /** F202 Phase 2: Schedule factory registry (required for schedule resources) */
  scheduleFactoryRegistry?: ScheduleFactoryRegistry;
  /** F202 Phase 2: TaskRunner for registering/unregistering schedule tasks */
  taskRunner?: ScheduleTaskRunner;
  /** F202 Phase 2: Dependencies injected into schedule factory createTaskSpec */
  scheduleFactoryDeps?: ScheduleFactoryDeps;
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

function fallbackScheduleTaskId(manifestId: string, resourceName?: string): string | undefined {
  return resourceName ? `schedule:${manifestId}:${resourceName}` : undefined;
}

function scheduleNameFromCapabilityId(manifestId: string, capId: string): string | undefined {
  const normalizedId = normalizeCapId(capId);
  const prefix = `plugin:${manifestId}:`;
  if (!normalizedId.startsWith(prefix)) return undefined;
  const resourceName = normalizedId.slice(prefix.length);
  return resourceName || undefined;
}

function scheduleTaskIdForCapability(manifestId: string, cap: CapabilityEntry): string | undefined {
  return cap.scheduleTaskId ?? fallbackScheduleTaskId(manifestId, scheduleNameFromCapabilityId(manifestId, cap.id));
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

    // F202 Phase 2 follow-up: optional resources that fail don't block 'success' status
    const allRequiredOk = results.every((r, i) => r.ok || !!manifest.resources[i]?.optional);
    const someOk = results.some((r) => r.ok);
    return {
      status: allRequiredOk ? 'success' : someOk ? 'partial' : 'failed',
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
      case 'schedule':
        await this.activateSchedule(manifest, resource);
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
      case 'schedule':
        await this.deactivateSchedule(manifest, resource);
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
    const projectRoot = this.deps.resolveProjectRoot();
    const mainProjectRoot = this.deps.resolveMainProjectRoot?.() ?? projectRoot;
    const mountRules = await readMountRules(projectRoot, mainProjectRoot);
    const mountPaths = await this.readExistingPluginSkillMountPaths(manifest, resource);

    // F228: Use mountSkillSymlinks for filesystem + injected deps for config.
    // Directory-level symlink pre-check: if a mount point skills dir is a symlink
    // pointing to a different source (e.g. cat-cafe-skills), mountSkillSymlinks
    // will record a conflict — not a hard error for plugin activation.
    const skillsSource = dirname(skillSourceDir);
    for (const mountPointId of STANDARD_MOUNT_POINT_IDS) {
      if (!mountRules.mountPoints[mountPointId].enabled) continue;
      const skillsDir = join(projectRoot, mountRules.mountPoints[mountPointId].path);
      try {
        await isManagedDirectoryLevelSkillsSymlink(skillsDir, skillsSource);
      } catch (err) {
        // Legacy directory-level mount to a different source (e.g. cat-cafe-skills).
        // Only skip mount points not targeted by this plugin skill — for target mount points,
        // an invalid root symlink must hard-fail to prevent writing outside project.
        const isTarget = !mountPaths || mountPaths.includes(mountPointId);
        if (isTarget) throw err as Error;
      }
    }

    // Mount symlinks first (rollback only newly created if config write fails)
    const mountResult = await mountSkillSymlinks(
      projectRoot,
      skillName,
      skillsSource,
      mountRules,
      mountPaths ?? undefined,
    );

    // P1-2: Fail activation when all mount points conflict and nothing is mounted
    // (including already-managed symlinks from previous activation)
    if (mountResult.mounted.length === 0 && mountResult.conflicts.length > 0) {
      const targets = buildSkillMountTargets(projectRoot, homedir(), mountRules);
      let existingManagedCount = 0;
      for (const target of targets) {
        for (const dir of target.candidates) {
          const status = await classifyMountPath(join(dir, skillName), skillsSource, skillName);
          if (status === 'managed') existingManagedCount++;
        }
      }
      if (existingManagedCount === 0) {
        throw new Error(
          `All mount points conflict for skill '${skillName}': ${mountResult.conflicts.map((c) => c.path).join(', ')}`,
        );
      }
    }

    try {
      await this.upsertCapabilityEntry(manifest, resource, true);
    } catch (err) {
      // P2-1: Rollback uses exact paths from mount result (covers standard + custom)
      const { rm: rmFile } = await import('node:fs/promises');
      for (const m of mountResult.mounted) {
        try {
          await rmFile(m.path);
        } catch {
          /* best-effort rollback */
        }
      }
      throw err;
    }
  }

  private async deactivateSkill(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.path) return;

    const skillSourceDir = resolvePluginResourcePath(this.deps.pluginsDir, manifest.id, resource.path);
    const skillName = resourcePathBasename(resource.path);
    const projectRoot = this.deps.resolveProjectRoot();
    const mainProjectRoot = this.deps.resolveMainProjectRoot?.() ?? projectRoot;
    const mountRules = await readMountRules(projectRoot, mainProjectRoot);

    // Unmount symlinks + update config using injected deps
    await unmountSkillSymlinks(projectRoot, skillName, dirname(skillSourceDir), mountRules);
    await this.upsertCapabilityEntry(manifest, resource, false);
  }

  private async readExistingPluginSkillMountPaths(
    manifest: PluginManifest,
    resource: PluginResourceDef,
  ): Promise<readonly string[] | undefined> {
    const config = await this.deps.readCapabilities();
    if (!config) return undefined;
    const capId = resourceCapId(manifest.id, resource);
    const existing = config.capabilities.find(
      (c) => normalizeCapId(c.id) === capId && c.pluginId === manifest.id && c.type === 'skill',
    );
    return Array.isArray(existing?.mountPaths) ? [...existing.mountPaths] : undefined;
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

    // #712: Use shared MCP service (heal → write → generateCli → audit)
    // instead of generic upsertCapabilityEntry which bypassed topology heal
    // and audit logging.
    const projectRoot = this.deps.resolveProjectRoot();
    const capId = resourceCapId(manifest.id, resource);
    const entry: CapabilityEntry = {
      id: capId,
      type: 'mcp',
      enabled: true,
      source: 'cat-cafe',
      pluginId: manifest.id,
      mcpServer: this.buildMcpServer(manifest, resource),
    };

    const { before } = await installMcpCapability(projectRoot, entry, this.mcpConfigIO(), {
      userId: `plugin:${manifest.id}`,
    });

    // Type transition cleanup: if the old entry was a different type,
    // clean up its runtime resources (schedule task, limb node).
    if (before && before.type !== 'mcp' && before.enabled) {
      if (before.type === 'schedule' && this.deps.taskRunner) {
        const taskId = scheduleTaskIdForCapability(manifest.id, before);
        if (taskId) {
          try {
            this.deps.taskRunner.unregister(taskId);
          } catch {
            /* best-effort */
          }
        }
      } else if (before.type === 'limb' && before.limbNodeId) {
        try {
          this.deps.limbRegistry.deregister(before.limbNodeId);
        } catch {
          /* best-effort */
        }
      }
    }
  }

  private async deactivateMcp(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    // #712: Use shared MCP service with hard-remove.
    // removeMcpCapability(hard=true) handles the two-phase dance internally:
    //   1. Disable → write → CLI regen  (so CLI writers see disabled state and clean up)
    //   2. Splice → write → CLI regen   (entry removed from capabilities.json)
    const projectRoot = this.deps.resolveProjectRoot();
    const capId = resourceCapId(manifest.id, resource);

    await removeMcpCapability(projectRoot, capId, this.mcpConfigIO(), {
      hard: true,
      pluginId: manifest.id,
      userId: `plugin:${manifest.id}`,
    });
  }

  private async activateSchedule(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.factoryId) throw new Error('Schedule resource must have a factoryId');
    if (!resource.name) throw new Error('Schedule resource must have a name');
    if (!this.deps.scheduleFactoryRegistry) throw new Error('ScheduleFactoryRegistry not configured');
    if (!this.deps.taskRunner) throw new Error('TaskRunner not configured');

    const factory = this.deps.scheduleFactoryRegistry.getForPlugin(resource.factoryId, manifest.id);
    if (!factory) {
      const existing = this.deps.scheduleFactoryRegistry.get(resource.factoryId);
      if (existing) {
        throw new Error(
          `Schedule factory '${resource.factoryId}' is owned by plugin '${existing.pluginId}', not owned by plugin '${manifest.id}'`,
        );
      }
      throw new Error(`Unknown schedule factory '${resource.factoryId}'`);
    }

    const taskId = `schedule:${manifest.id}:${resource.name}`;
    const taskSpec = factory.createTaskSpec(taskId, this.deps.scheduleFactoryDeps ?? { log: console });

    // Defensive: factory must return a spec with the ID we requested
    if (taskSpec.id !== taskId) {
      throw new Error(
        `Schedule factory '${resource.factoryId}' returned mismatched task ID: expected '${taskId}', got '${taskSpec.id}'`,
      );
    }

    // Idempotent re-enable: try to register; if already exists (duplicate),
    // the existing task keeps running — no window of inconsistency.
    // Only rollback on write failure if WE added the registration.
    let newRegistration = false;
    try {
      this.deps.taskRunner.registerPostStart(taskSpec);
      newRegistration = true;
    } catch {
      // Task already registered with same ID — idempotent, keep existing task running
    }

    try {
      await this.upsertCapabilityEntry(manifest, resource, true, undefined, taskId);
    } catch (err) {
      // Rollback: only unregister if we were the ones who registered
      if (newRegistration) {
        this.deps.taskRunner.unregister(taskId);
      }
      throw err;
    }
  }

  private async deactivateSchedule(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
    if (!resource.name) return;

    // Persist removal first — runtime cleanup only after successful write.
    // Invariant: runtime state ↔ persisted state must stay in sync;
    // if persist fails, runtime task must keep running (mirrors deactivateLimb).
    const removedEntries = await this.removeCapabilityEntry(manifest, resource);
    const ownedEntry = removedEntries.find((c) => c.type === 'schedule' && c.pluginId === manifest.id && c.enabled);
    const taskId = ownedEntry
      ? (ownedEntry.scheduleTaskId ?? fallbackScheduleTaskId(manifest.id, resource.name))
      : undefined;
    if (taskId && this.deps.taskRunner) {
      this.deps.taskRunner.unregister(taskId);
    }
  }

  private async upsertCapabilityEntry(
    manifest: PluginManifest,
    resource: PluginResourceDef,
    enabled: boolean,
    limbNodeId?: string,
    scheduleTaskId?: string,
  ): Promise<CapabilitiesConfig | null> {
    return this.deps.withCapabilityLock(async () => {
      const config = await this.deps.readCapabilities();
      const previous = config ? structuredClone(config) : null;
      const cap: CapabilitiesConfig = config ? structuredClone(config) : { version: 1, capabilities: [] };
      const capId = resourceCapId(manifest.id, resource);

      let staleLimbNodeIdToClean: string | undefined;
      let staleScheduleTaskIdToClean: string | undefined;
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

        // F202 Phase 2: capture stale schedule taskId before type transition (mirrors limb pattern)
        staleScheduleTaskIdToClean =
          existing.type === 'schedule' && resource.type !== 'schedule' && existing.enabled
            ? scheduleTaskIdForCapability(manifest.id, existing)
            : undefined;

        existing.type = resource.type as CapabilityEntry['type'];
        existing.enabled = enabled;
        existing.pluginId = manifest.id;
        if (resource.type === 'mcp') {
          delete existing.limbNodeId;
          delete existing.scheduleTaskId;
          existing.mcpServer = this.buildMcpServer(manifest, resource);
        } else if (resource.type === 'schedule') {
          delete existing.mcpServer;
          delete existing.limbNodeId;
          if (scheduleTaskId) existing.scheduleTaskId = scheduleTaskId;
        } else {
          delete existing.mcpServer;
          delete existing.scheduleTaskId;
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
          type: resource.type as CapabilityEntry['type'],
          enabled,
          source: 'cat-cafe',
          pluginId: manifest.id,
          ...(limbNodeId ? { limbNodeId } : {}),
          ...(scheduleTaskId ? { scheduleTaskId } : {}),
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
      // F202 Phase 2: unregister stale schedule task only after config write succeeds
      if (staleScheduleTaskIdToClean && this.deps.taskRunner) {
        try {
          this.deps.taskRunner.unregister(staleScheduleTaskIdToClean);
        } catch {
          /* best-effort: task may already be gone */
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
    // #712 P2: Route orphaned MCP entries through the shared service
    // (removeMcpCapability handles disable→remove + heal + audit).
    // Done BEFORE the main lock since removeMcpCapability manages its own locking.
    const preConfig = await this.deps.readCapabilities();
    if (preConfig) {
      const mcpOrphanIds = preConfig.capabilities
        .filter((c) => c.pluginId === manifest.id && c.type === 'mcp' && !declaredIds.has(normalizeCapId(c.id)))
        .map((c) => c.id);
      const projectRoot = this.deps.resolveProjectRoot();
      for (const capId of mcpOrphanIds) {
        await removeMcpCapability(projectRoot, capId, this.mcpConfigIO(), {
          hard: true,
          pluginId: manifest.id,
          userId: `plugin:${manifest.id}`,
        });
      }
    }

    // Remaining (non-MCP) orphans: limb + schedule — batch in one lock.
    const limbNodeIds: string[] = [];
    const scheduleTaskIds: string[] = [];
    await this.deps.withCapabilityLock(async () => {
      const config = await this.deps.readCapabilities();
      if (!config) return;
      const isOrphan = (c: CapabilityEntry) => c.pluginId === manifest.id && !declaredIds.has(normalizeCapId(c.id));
      const orphaned = config.capabilities.filter(isOrphan);
      if (orphaned.length === 0) return;

      for (const cap of orphaned) {
        if (cap.type === 'limb' && cap.enabled && cap.limbNodeId) {
          limbNodeIds.push(cap.limbNodeId);
        }
        // F202 Phase 2: collect orphaned schedule tasks for post-lock unregistration
        if (cap.type === 'schedule' && cap.enabled) {
          const taskId = scheduleTaskIdForCapability(manifest.id, cap);
          if (taskId) scheduleTaskIds.push(taskId);
        }
      }
      const previous = structuredClone(config);
      const next = structuredClone(config);
      next.capabilities = next.capabilities.filter((c) => !isOrphan(c));
      await this.writeCapabilitiesWithRollback(previous, next);
    });

    for (const nodeId of limbNodeIds) {
      this.deps.limbRegistry.deregister(nodeId);
    }
    // F202 Phase 2: unregister orphaned schedule tasks (outside the lock — same pattern as limb)
    for (const taskId of scheduleTaskIds) {
      this.deps.taskRunner?.unregister(taskId);
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

  /** Adapt DI deps to the shared McpConfigIO interface (#712). */
  private mcpConfigIO(): McpConfigIO {
    return {
      readConfig: () => this.deps.readCapabilities(),
      writeAndRegenCli: (config) => this.deps.writeCapabilities(config),
      withLock: (fn) => this.deps.withCapabilityLock(fn),
    };
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
}

// ─── F202 Phase 2: Schedule resource rehydration (startup recovery) ──────────

export interface PluginScheduleRehydrationDeps {
  capabilities: CapabilitiesConfig | null;
  pluginRegistry: Pick<import('./PluginRegistry.js').PluginRegistry, 'getManifest'>;
  scheduleFactoryRegistry: ScheduleFactoryRegistry;
  taskRunner: { register(task: TaskSpec_P1): void };
  scheduleFactoryDeps: ScheduleFactoryDeps;
  log?: Pick<Console, 'info' | 'warn'>;
}

/**
 * Rehydrate enabled schedule resources at startup.
 * Reads capabilities.json for type=schedule + enabled=true entries,
 * looks up the factory in ScheduleFactoryRegistry, and registers
 * the TaskSpec in TaskRunnerV2 (via register, not registerDynamic —
 * TaskRunnerV2.start() hasn't been called yet at rehydration time).
 */
export async function rehydrateEnabledPluginSchedules(deps: PluginScheduleRehydrationDeps): Promise<void> {
  if (!deps.capabilities) return;

  const scheduleEntries = deps.capabilities.capabilities.filter(
    (c) => c.type === 'schedule' && c.enabled && c.pluginId,
  );

  for (const cap of scheduleEntries) {
    const manifest = deps.pluginRegistry.getManifest(cap.pluginId!);
    if (!manifest) continue;

    const normalizedId = normalizeCapId(cap.id);
    const scheduleResource = manifest.resources.find(
      (r) => r.type === 'schedule' && resourceCapId(manifest.id, r) === normalizedId,
    );
    if (!scheduleResource?.factoryId) continue;

    const factory = deps.scheduleFactoryRegistry.getForPlugin(scheduleResource.factoryId, manifest.id);
    if (!factory) {
      const existing = deps.scheduleFactoryRegistry.get(scheduleResource.factoryId);
      const reason = existing
        ? `owned by plugin '${existing.pluginId}', not owned by plugin '${manifest.id}'`
        : 'not registered';
      deps.log?.warn(`[F202-2] Skip rehydration for factory '${scheduleResource.factoryId}' (${reason})`);
      continue;
    }

    const taskId = cap.scheduleTaskId ?? fallbackScheduleTaskId(manifest.id, scheduleResource.name);
    if (!taskId) continue;
    try {
      const taskSpec = factory.createTaskSpec(taskId, deps.scheduleFactoryDeps);
      // Defensive: factory must return a spec with the expected ID (mirrors activation path)
      if (taskSpec.id !== taskId) {
        deps.log?.warn(
          `[F202-2] Factory '${scheduleResource.factoryId}' returned mismatched task ID on rehydration: expected '${taskId}', got '${taskSpec.id}' — skipping`,
        );
        continue;
      }
      deps.taskRunner.register(taskSpec);
      deps.log?.info(`[F202-2] Rehydrated schedule '${scheduleResource.name}' for plugin '${manifest.id}'`);
    } catch (err) {
      deps.log?.warn(`[F202-2] Failed to rehydrate schedule for '${manifest.id}': ${(err as Error).message}`);
    }
  }
}
