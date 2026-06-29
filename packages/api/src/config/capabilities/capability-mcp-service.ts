/**
 * Shared MCP install / remove service — #712 single-source-of-truth
 *
 * Canonical MCP mutation pipeline:
 *   lock → read → heal → validate → mutate → write → generateCli → audit
 *
 * Currently used by:
 *   - PluginResourceActivator (activateMcp / deactivateMcp / orphan cleanup)
 *
 * NOT yet used by:
 *   - HTTP route handlers (capabilities-mcp-write.ts) — still inline;
 *     migrating the routes is a follow-up to avoid bloating this PR.
 *
 * The I/O layer (read/write/lock) is pluggable via McpConfigIO:
 *   - fileBasedMcpIO() reads/writes capabilities.json + CLI configs directly
 *   - PluginResourceActivator wraps its DI deps via mcpConfigIO()
 *
 * The orchestration logic (heal, ownership check, audit, rollback) is
 * always the same regardless of I/O adapter.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CapabilitiesConfig, CapabilityEntry } from '@cat-cafe/shared';
import { appendAuditEntry } from './capability-audit.js';
import {
  type CliConfigPaths,
  generateCliConfigs,
  healCatCafeMcpTopology,
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from './capability-orchestrator.js';

// ────────── I/O adapter ──────────

/** Pluggable config I/O — separates orchestration logic from storage. */
export interface McpConfigIO {
  readConfig: () => Promise<CapabilitiesConfig | null>;
  /** Write config AND regenerate CLI config files. */
  writeAndRegenCli: (config: CapabilitiesConfig) => Promise<void>;
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** Default file-based I/O adapter — reads/writes capabilities.json + CLI configs. */
export function fileBasedMcpIO(projectRoot: string, cliConfigPaths?: CliConfigPaths): McpConfigIO {
  const paths = cliConfigPaths ?? {
    google: join(projectRoot, '.gemini', 'settings.json'),
    antigravity: join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
  };
  return {
    readConfig: () => readCapabilitiesConfig(projectRoot),
    writeAndRegenCli: async (config) => {
      await writeCapabilitiesConfig(projectRoot, config);
      await generateCliConfigs(config, paths, projectRoot);
    },
    withLock: (fn) => withCapabilityLock(projectRoot, fn),
  };
}

// ────────── Options ──────────

export interface McpServiceOpts {
  /** Cat Cafe monorepo root for topology healing. */
  catCafeRepoRoot?: string;
  /** User/actor id recorded in the audit log. */
  userId?: string;
}

export interface McpRemoveOpts extends McpServiceOpts {
  /** true = splice the entry out; false (default) = soft-disable. */
  hard?: boolean;
  /** When set, only match entries owned by this plugin. */
  pluginId?: string;
}

// ────────── Install ──────────

/**
 * Install or update an MCP capability entry through the standard pipeline.
 *
 * Pipeline: lock → read → heal → ownership check → upsert → write →
 *           generateCliConfigs → audit.
 *
 * Returns the before/after snapshots for the caller's convenience.
 */
export async function installMcpCapability(
  projectRoot: string,
  entry: CapabilityEntry,
  io: McpConfigIO,
  opts?: McpServiceOpts,
): Promise<{ before: CapabilityEntry | null; after: CapabilityEntry }> {
  return io.withLock(async () => {
    let config: CapabilitiesConfig = (await io.readConfig()) ?? { version: 1, capabilities: [] };
    const snapshot = structuredClone(config);

    if (opts?.catCafeRepoRoot) {
      config = healCatCafeMcpTopology(config, { catCafeRepoRoot: opts.catCafeRepoRoot }).config;
    }

    // Plugin entries: match by id + pluginId to support type transitions
    // (schedule→MCP, limb→MCP).  Non-plugin entries: match by id + type=mcp.
    const existingIdx = entry.pluginId
      ? config.capabilities.findIndex((c) => c.id === entry.id && c.pluginId === entry.pluginId)
      : config.capabilities.findIndex((c) => c.id === entry.id && c.type === 'mcp');
    const before = existingIdx >= 0 ? structuredClone(config.capabilities[existingIdx]) : null;

    // Plugin ownership validation (only when the incoming entry has a pluginId)
    if (entry.pluginId && existingIdx >= 0) {
      const existing = config.capabilities[existingIdx];
      if (existing.pluginId !== undefined && existing.pluginId !== entry.pluginId) {
        throw new Error(`Capability '${entry.id}' is already owned by plugin '${existing.pluginId}'`);
      }
      if (existing.pluginId === undefined) {
        throw new Error(`Capability '${entry.id}' exists as a non-plugin entry and cannot be claimed`);
      }
    }

    if (existingIdx >= 0) {
      // On type transition → MCP: clear non-MCP fields from the old entry
      const merged = { ...config.capabilities[existingIdx], ...entry };
      if (config.capabilities[existingIdx].type !== 'mcp') {
        delete merged.limbNodeId;
        delete merged.scheduleTaskId;
      }
      config.capabilities[existingIdx] = merged;
    } else {
      config.capabilities.push(entry);
    }

    // #712 review P1-7: safe access — entry may have been a type-transition (pluginId match, not type=mcp)
    const afterIdx = entry.pluginId
      ? config.capabilities.findIndex((c) => c.id === entry.id && c.pluginId === entry.pluginId)
      : config.capabilities.findIndex((c) => c.id === entry.id && c.type === 'mcp');
    const afterEntry = structuredClone(
      config.capabilities[afterIdx >= 0 ? afterIdx : existingIdx >= 0 ? existingIdx : config.capabilities.length - 1],
    );

    try {
      await io.writeAndRegenCli(config);
    } catch (err) {
      // Rollback to pre-mutation state on write/CLI failure
      try {
        await io.writeAndRegenCli(snapshot);
      } catch {
        /* best-effort rollback */
      }
      throw err;
    }

    await appendAuditEntry(projectRoot, {
      timestamp: new Date().toISOString(),
      userId: opts?.userId ?? 'system',
      action: before ? 'update' : 'install',
      capabilityId: entry.id,
      before,
      after: afterEntry,
    });

    return { before, after: afterEntry };
  });
}

// ────────── Remove ──────────

/**
 * Remove or soft-disable an MCP capability entry through the standard pipeline.
 *
 * When `hard = true`:
 *   1. Disable the entry + write + CLI regen  (so CLI writers clean up stale config)
 *   2. Splice the entry out + write + CLI regen
 *
 * When `hard = false` (default): soft-disable only.
 */
export async function removeMcpCapability(
  projectRoot: string,
  capabilityId: string,
  io: McpConfigIO,
  opts?: McpRemoveOpts,
): Promise<{ before: CapabilityEntry | null }> {
  return io.withLock(async () => {
    const config = await io.readConfig();
    if (!config) return { before: null };

    let nextConfig = structuredClone(config);
    if (opts?.catCafeRepoRoot) {
      nextConfig = healCatCafeMcpTopology(nextConfig, {
        catCafeRepoRoot: opts.catCafeRepoRoot,
      }).config;
    }

    const predicate = opts?.pluginId
      ? (c: CapabilityEntry) => c.id === capabilityId && c.type === 'mcp' && c.pluginId === opts.pluginId
      : (c: CapabilityEntry) => c.id === capabilityId && c.type === 'mcp';

    const idx = nextConfig.capabilities.findIndex(predicate);
    if (idx === -1) return { before: null };

    const before = structuredClone(nextConfig.capabilities[idx]);
    const snapshot = structuredClone(config);

    try {
      if (opts?.hard) {
        // Phase 1: Disable so CLI writers see the disabled state and clean up
        if (before.enabled || before.globalEnabled !== false) {
          nextConfig.capabilities[idx].enabled = false;
          // #712 review P2-13: set globalEnabled=false (canonical field) alongside legacy enabled
          nextConfig.capabilities[idx].globalEnabled = false;
          await io.writeAndRegenCli(nextConfig);
        }
        // Phase 2: Remove entry entirely
        nextConfig.capabilities.splice(idx, 1);
      } else {
        nextConfig.capabilities[idx].enabled = false;
        // #712 review P2-13: set globalEnabled=false (canonical field) alongside legacy enabled
        nextConfig.capabilities[idx].globalEnabled = false;
      }

      await io.writeAndRegenCli(nextConfig);
    } catch (err) {
      try {
        await io.writeAndRegenCli(snapshot);
      } catch {
        /* best-effort rollback */
      }
      throw err;
    }

    await appendAuditEntry(projectRoot, {
      timestamp: new Date().toISOString(),
      userId: opts?.userId ?? 'system',
      action: 'delete',
      capabilityId,
      before,
      after: opts?.hard ? null : (nextConfig.capabilities.find(predicate) ?? null),
    });

    return { before };
  });
}
