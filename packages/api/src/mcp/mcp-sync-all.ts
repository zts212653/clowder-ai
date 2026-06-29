/**
 * MCP Sync All — F249
 *
 * `syncMcpAll` cascades global MCP state to all known projects.
 * Uses the unified listAllProjectPaths (#712) to enumerate governance-registered
 * AND nested thread-derived projects.
 */

import { catRegistry } from '@cat-cafe/shared';
import { readCapabilitiesConfig, withCapabilityLock } from '../config/capabilities/capability-orchestrator.js';
import { listAllProjectPaths } from '../config/governance/list-all-projects.js';
import { extractMcpEntries, type SyncMcpProjectResult, syncMcpProject } from './mcp-sync-engine.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SyncMcpAllResult {
  projects: Array<{ path: string; result: SyncMcpProjectResult } | { path: string; skipped: true; reason: string }>;
  summary: { synced: number; skipped: number };
}

// ── syncMcpAll ───────────────────────────────────────────────────────────────

/**
 * Cascade global MCP config to all registered projects.
 *
 * Flow (spec §9.2):
 *   1. Read global capabilities.json, build globalDisabledMcps
 *   2. From GovernanceRegistry, list all projects
 *   3. For each: syncMcpProject (pass cascadeDisabledMcps)
 *   4. Skip stale registry entries (missing/non-directory paths)
 */
export function syncMcpAll(catCafeRoot: string): Promise<SyncMcpAllResult> {
  return withCapabilityLock(catCafeRoot, () => syncMcpAllUnlocked(catCafeRoot));
}

async function syncMcpAllUnlocked(catCafeRoot: string): Promise<SyncMcpAllResult> {
  const projects: SyncMcpAllResult['projects'] = [];
  let synced = 0;
  let skippedCount = 0;

  // 1. Read global config and build cascade sets
  const mainConfig = await readCapabilitiesConfig(catCafeRoot);
  const globalMcpEntries = extractMcpEntries(mainConfig);

  // MCPs that are globally disabled → cascade as disabled to projects
  const globalDisabledMcps = new Set(
    globalMcpEntries.filter((cap) => !(cap.globalEnabled ?? cap.enabled)).map((cap) => cap.id),
  );

  // All known cat IDs (for populating blockedCats on cascade-disable)
  const allCatIds = [...catRegistry.getAllIds()];

  // 2. List all projects (governance-registered + nested thread-derived)
  //    listAllProjectPaths already excludes catCafeRoot and validates paths.
  const projectPaths = await listAllProjectPaths(catCafeRoot);

  // 3. Sync each project
  for (const projectPath of projectPaths) {
    try {
      const result = await syncMcpProject(projectPath, catCafeRoot, {
        globalMcpEntries,
        cascadeDisabledMcps: globalDisabledMcps,
        allCatIds,
      });
      projects.push({ path: projectPath, result });
      synced++;
    } catch (err) {
      const reason = (err as Error).message;
      console.warn(`[F249] ${projectPath}: ${reason}`);
      projects.push({ path: projectPath, skipped: true, reason });
      skippedCount++;
    }
  }

  return { projects, summary: { synced, skipped: skippedCount } };
}
