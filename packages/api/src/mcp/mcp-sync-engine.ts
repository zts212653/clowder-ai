/**
 * MCP Sync Engine — F249: syncMcpProject reconciles project MCP config with global.
 *
 * Unlike skill sync (which manages symlinks), MCP sync is pure config-level:
 * copies MCP entries from global → project capabilities.json, respecting
 * blockedCats and mcpServerOverride.
 */

import { createHash } from 'node:crypto';
import type { CapabilitiesConfig, CapabilityEntry } from '@cat-cafe/shared';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../config/capabilities/capability-orchestrator.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SyncMcpProjectOptions {
  /** Global MCP entries (pre-read by caller to avoid redundant I/O in syncAll). */
  globalMcpEntries?: CapabilityEntry[];
  /** MCP IDs that should be cascade-disabled (blockedCats = all cats). */
  cascadeDisabledMcps?: ReadonlySet<string>;
  /** All known cat IDs — used to populate blockedCats when cascade-disabling. */
  allCatIds?: readonly string[];
}

export interface SyncMcpProjectResult {
  /** MCP IDs newly added to the project. */
  added: string[];
  /** MCP IDs removed from the project (orphans). */
  removed: string[];
  /** MCP IDs whose config was updated (global changed, no override). */
  updated: string[];
  /** MCP IDs skipped because project has mcpServerOverride. */
  skipped: string[];
  /** Hash of global MCP config at sync time. */
  syncedHash: string;
}

// ── Canonical JSON ──────────────────────────────────────────────────────────

/**
 * JSON.stringify with sorted keys (recursive) for deterministic hashing.
 * Avoids false config-mismatch when object key order differs.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce<Record<string, unknown>>((sorted, k) => {
          sorted[k] = (val as Record<string, unknown>)[k];
          return sorted;
        }, {});
    }
    return val;
  });
}

// ── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Compute a hash over the global MCP config for drift detection.
 * Deterministic: sorts entries by id, hashes id + mcpServer fields.
 */
export function computeGlobalMcpHash(globalMcpEntries: CapabilityEntry[]): string {
  const hash = createHash('sha256');
  const sorted = [...globalMcpEntries].sort((a, b) => a.id.localeCompare(b.id));
  for (const entry of sorted) {
    hash.update(entry.id);
    hash.update(canonicalJson(entry.mcpServer ?? {}));
    hash.update(String(entry.globalEnabled ?? true));
  }
  return hash.digest('hex').slice(0, 16);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract MCP-type entries from a capabilities config. */
export function extractMcpEntries(config: CapabilitiesConfig | null): CapabilityEntry[] {
  return config?.capabilities.filter((cap) => cap.type === 'mcp') ?? [];
}

/**
 * Build a project-level MCP entry from a global entry.
 * Copies the global mcpServer config and sets blockedCats to empty (all cats enabled).
 */
function buildProjectEntry(globalEntry: CapabilityEntry, blockedCats: string[]): CapabilityEntry {
  const enabled = globalEntry.globalEnabled ?? true;
  return {
    id: globalEntry.id,
    type: 'mcp',
    enabled,
    globalEnabled: enabled,
    source: globalEntry.source,
    mcpServer: globalEntry.mcpServer ? { ...globalEntry.mcpServer } : undefined,
    blockedCats,
    ...(globalEntry.pluginId ? { pluginId: globalEntry.pluginId } : {}),
  };
}

// ── syncMcpProject ───────────────────────────────────────────────────────────

/**
 * Sync MCP config from global to a single project.
 *
 * Flow (spec §9.1):
 *   1. withCapabilityLock(projectRoot) for mutual exclusion
 *   2. Read global + project capabilities.json
 *   3. Diff: new / removed / config-updated entries
 *   4. Skip entries with mcpServerOverride (project customization)
 *   5. Write updated project capabilities.json
 *   6. Update mcpSync state
 */
export function syncMcpProject(
  projectRoot: string,
  catCafeRoot: string,
  opts?: SyncMcpProjectOptions,
): Promise<SyncMcpProjectResult> {
  return withCapabilityLock(projectRoot, () => syncMcpProjectUnlocked(projectRoot, catCafeRoot, opts));
}

async function syncMcpProjectUnlocked(
  projectRoot: string,
  catCafeRoot: string,
  opts?: SyncMcpProjectOptions,
): Promise<SyncMcpProjectResult> {
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  // 1. Read global MCP entries (from caller or fresh read)
  const globalMcpEntries = opts?.globalMcpEntries ?? extractMcpEntries(await readCapabilitiesConfig(catCafeRoot));
  const globalMcpMap = new Map(globalMcpEntries.map((e) => [e.id, e]));
  const syncedHash = computeGlobalMcpHash(globalMcpEntries);

  // 2. Read project config (create minimal if missing)
  let projectConfig = await readCapabilitiesConfig(projectRoot);
  if (!projectConfig) {
    projectConfig = { version: 2, capabilities: [] };
  }

  const projectMcpMap = new Map<string, CapabilityEntry>();
  for (const cap of projectConfig.capabilities) {
    if (cap.type === 'mcp') projectMcpMap.set(cap.id, cap);
  }

  // 3. Cascade disabled MCP set + tracked cascade history
  const cascadeDisabled = opts?.cascadeDisabledMcps ?? new Set<string>();
  const allCatIds = opts?.allCatIds ?? [];
  const prevCascade = new Set(projectConfig.mcpSync?.cascadeDisabledMcps ?? []);
  const newCascadeDisabled: string[] = [];

  // 4. Process: add new, update changed, track skipped
  for (const [mcpId, globalEntry] of globalMcpMap) {
    const projectEntry = projectMcpMap.get(mcpId);

    if (!projectEntry) {
      // New: add to project
      const isCascadeDisabled = cascadeDisabled.has(mcpId);
      const blockedCats = isCascadeDisabled ? [...allCatIds] : [];
      added.push(mcpId);
      if (isCascadeDisabled) newCascadeDisabled.push(mcpId);

      const newEntry = buildProjectEntry(globalEntry, blockedCats);
      projectConfig.capabilities.push(newEntry);
      continue;
    }

    // Existing: check if config changed
    if (projectEntry.mcpServerOverride) {
      // Has override — skip config update (drift detection will flag it)
      skipped.push(mcpId);
      continue;
    }

    // Compare global mcpServer with project's copy
    const globalServerJson = canonicalJson(globalEntry.mcpServer ?? {});
    const projectServerJson = canonicalJson(projectEntry.mcpServer ?? {});
    if (globalServerJson !== projectServerJson) {
      // Config changed in global — update project
      projectEntry.mcpServer = globalEntry.mcpServer ? { ...globalEntry.mcpServer } : undefined;
      updated.push(mcpId);
    }

    // Sync globalEnabled state (legacy `enabled` field no longer written)
    projectEntry.globalEnabled = globalEntry.globalEnabled;

    // Cascade disable/re-enable logic
    if (cascadeDisabled.has(mcpId) && !prevCascade.has(mcpId)) {
      // Newly cascade-disabled: set blockedCats to all cats
      projectEntry.blockedCats = [...allCatIds];
      newCascadeDisabled.push(mcpId);
    } else if (!cascadeDisabled.has(mcpId) && prevCascade.has(mcpId)) {
      // Re-enabled globally: clear cascade-disabled blockedCats
      projectEntry.blockedCats = [];
    } else if (cascadeDisabled.has(mcpId)) {
      newCascadeDisabled.push(mcpId);
    }
  }

  // 5. Process: remove orphans (in project but not global, unless external)
  for (const [mcpId, projectEntry] of projectMcpMap) {
    if (!globalMcpMap.has(mcpId) && projectEntry.source !== 'external') {
      removed.push(mcpId);
      projectConfig.capabilities = projectConfig.capabilities.filter(
        (cap) => !(cap.type === 'mcp' && cap.id === mcpId),
      );
    }
  }

  // 6. Update mcpSync state
  projectConfig.mcpSync = {
    sourceConfigHash: syncedHash,
    lastSyncedAt: new Date().toISOString(),
    ...(newCascadeDisabled.length > 0 ? { cascadeDisabledMcps: newCascadeDisabled } : {}),
  };

  // 7. Write
  await writeCapabilitiesConfig(projectRoot, projectConfig);

  return { added, removed, updated, skipped, syncedHash };
}
