/**
 * MCP Drift Resolver — F249
 *
 * Resolves drift issues found by mcp-drift-detector.
 * Applies sync operations: add new, remove orphans, update mismatched configs.
 *
 * Unlike skill drift resolver (which manages symlink backups), MCP drift
 * resolver is pure config-level: reads/writes capabilities.json entries.
 */

import type { CapabilitiesConfig, CapabilityEntry } from '@cat-cafe/shared';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../config/capabilities/capability-orchestrator.js';
import type { McpDriftResult, McpIssue } from './mcp-drift-detector.js';
import { computeGlobalMcpHash, extractMcpEntries } from './mcp-sync-engine.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Valid decision values for MCP drift resolution — the resolver contract. */
export const VALID_MCP_DRIFT_DECISIONS = new Set(['use-global', 'keep-project'] as const);

export interface McpDriftResolution {
  mcpId: string;
  /** use-global: overwrite with global config. keep-project: skip (user wants to keep). */
  decision: 'use-global' | 'keep-project';
}

export interface McpDriftSyncReport {
  /** MCP IDs added to project (from global-new issues). */
  added: string[];
  /** MCP IDs removed from project (from project-orphan issues). */
  removed: string[];
  /** MCP IDs whose config was updated (from config-mismatch with use-global). */
  updated: string[];
  /** MCP IDs user chose to keep (from config-mismatch with keep-project). */
  skipped: string[];
  /** New hash after resolution. */
  syncedHash: string;
}

// ── syncMcpDrift ─────────────────────────────────────────────────────────────

/**
 * Resolve MCP drift for a project (spec §6.4).
 *
 * @param projectRoot - project directory
 * @param catCafeRoot - main project (global config) directory
 * @param drift - drift result from checkMcpProject
 * @param resolutions - per-issue decisions (for config-mismatch); defaults to use-global
 */
export function syncMcpDrift(
  projectRoot: string,
  catCafeRoot: string,
  drift: McpDriftResult,
  resolutions?: McpDriftResolution[],
): Promise<McpDriftSyncReport> {
  return withCapabilityLock(projectRoot, () => syncMcpDriftUnlocked(projectRoot, catCafeRoot, drift, resolutions));
}

async function syncMcpDriftUnlocked(
  projectRoot: string,
  catCafeRoot: string,
  drift: McpDriftResult,
  resolutions?: McpDriftResolution[],
): Promise<McpDriftSyncReport> {
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  const resolutionMap = new Map((resolutions ?? []).map((r) => [r.mcpId, r.decision]));

  // Read configs
  const globalConfig = await readCapabilitiesConfig(catCafeRoot);
  const globalMcpMap = new Map(extractMcpEntries(globalConfig).map((e) => [e.id, e]));

  let projectConfig = await readCapabilitiesConfig(projectRoot);
  if (!projectConfig) {
    projectConfig = { version: 2, capabilities: [] };
  }

  // Process each issue
  for (const issue of drift.issues) {
    switch (issue.type) {
      case 'global-new':
        resolveGlobalNew(issue, globalMcpMap, projectConfig, added);
        break;
      case 'project-orphan':
        resolveProjectOrphan(issue, projectConfig, removed);
        break;
      case 'config-mismatch':
        resolveConfigMismatch(issue, globalMcpMap, projectConfig, resolutionMap, updated, skipped);
        break;
    }
  }

  // Update mcpSync state
  const globalMcpEntries = extractMcpEntries(globalConfig);
  const syncedHash = computeGlobalMcpHash(globalMcpEntries);

  projectConfig.mcpSync = {
    sourceConfigHash: syncedHash,
    lastSyncedAt: new Date().toISOString(),
    ...(projectConfig.mcpSync?.cascadeDisabledMcps?.length
      ? { cascadeDisabledMcps: projectConfig.mcpSync.cascadeDisabledMcps }
      : {}),
  };

  await writeCapabilitiesConfig(projectRoot, projectConfig);

  return { added, removed, updated, skipped, syncedHash };
}

// ── Resolvers per issue type ─────────────────────────────────────────────────

/**
 * global-new → add MCP entry to project (blockedCats=[]).
 */
function resolveGlobalNew(
  issue: McpIssue,
  globalMcpMap: Map<string, CapabilityEntry>,
  projectConfig: CapabilitiesConfig,
  added: string[],
): void {
  const globalEntry = globalMcpMap.get(issue.mcpId);
  if (!globalEntry) return;

  projectConfig.capabilities.push({
    id: globalEntry.id,
    type: 'mcp',
    enabled: globalEntry.enabled,
    globalEnabled: globalEntry.globalEnabled,
    source: globalEntry.source,
    mcpServer: globalEntry.mcpServer ? { ...globalEntry.mcpServer } : undefined,
    blockedCats: [],
    ...(globalEntry.pluginId ? { pluginId: globalEntry.pluginId } : {}),
  });
  added.push(issue.mcpId);
}

/**
 * project-orphan → remove MCP entry from project.
 */
function resolveProjectOrphan(issue: McpIssue, projectConfig: CapabilitiesConfig, removed: string[]): void {
  projectConfig.capabilities = projectConfig.capabilities.filter(
    (cap) => !(cap.type === 'mcp' && cap.id === issue.mcpId),
  );
  removed.push(issue.mcpId);
}

/**
 * config-mismatch → use global or keep project based on resolution.
 * Default: use-global (overwrite + clear override).
 */
function resolveConfigMismatch(
  issue: McpIssue,
  globalMcpMap: Map<string, CapabilityEntry>,
  projectConfig: CapabilitiesConfig,
  resolutionMap: Map<string, 'use-global' | 'keep-project'>,
  updatedList: string[],
  skippedList: string[],
): void {
  const decision = resolutionMap.get(issue.mcpId) ?? 'use-global';

  if (decision === 'keep-project') {
    skippedList.push(issue.mcpId);
    return;
  }

  // use-global: overwrite mcpServer + clear mcpServerOverride
  const globalEntry = globalMcpMap.get(issue.mcpId);
  if (!globalEntry) return;

  const projectEntry = projectConfig.capabilities.find((cap) => cap.type === 'mcp' && cap.id === issue.mcpId);
  if (!projectEntry) return;

  projectEntry.mcpServer = globalEntry.mcpServer ? { ...globalEntry.mcpServer } : undefined;
  // Clear override — spec §6.4: "删除 mcpServerOverride，回到使用全局配置"
  delete projectEntry.mcpServerOverride;
  projectEntry.globalEnabled = globalEntry.globalEnabled;
  projectEntry.enabled = globalEntry.enabled;

  updatedList.push(issue.mcpId);
}
