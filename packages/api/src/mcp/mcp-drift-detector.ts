/**
 * MCP Drift Detector — F249
 *
 * Compares global MCP config with project MCP config to detect drift.
 * Three issue types: global-new, project-orphan, config-mismatch.
 *
 * Unlike skill drift (which checks symlinks), MCP drift is pure config comparison.
 */

import { createHash } from 'node:crypto';
import type { CapabilitiesConfig, CapabilityEntry } from '@cat-cafe/shared';
import { readCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { listAllProjectPaths } from '../config/governance/list-all-projects.js';
import { canonicalJson, extractMcpEntries } from './mcp-sync-engine.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** MCP drift issue type (spec §6.2) */
export type McpIssueType = 'global-new' | 'project-orphan' | 'config-mismatch';

export interface McpIssue {
  type: McpIssueType;
  mcpId: string;
  /** Human-readable description */
  message: string;
  /** Whether the project entry has an override (relevant for config-mismatch) */
  hasOverride?: boolean;
}

export interface McpDriftResult {
  issues: McpIssue[];
  /** Hash of global + project state for change detection */
  driftHash: string;
  summary: { new: number; orphan: number; mismatch: number };
}

/** Global-level drift aggregation across all projects */
export interface McpGlobalDriftResult {
  perProject: Array<{
    path: string;
    result: McpDriftResult;
  }>;
  totalSummary: { new: number; orphan: number; mismatch: number; projectsWithDrift: number };
}

// ── Hash ─────────────────────────────────────────────────────────────────────

function computeDriftHash(globalEntries: CapabilityEntry[], projectEntries: CapabilityEntry[]): string {
  const hash = createHash('sha256');
  const sortedGlobal = [...globalEntries].sort((a, b) => a.id.localeCompare(b.id));
  const sortedProject = [...projectEntries].sort((a, b) => a.id.localeCompare(b.id));
  hash.update('global:');
  for (const e of sortedGlobal) {
    hash.update(`${e.id}:${canonicalJson(e.mcpServer ?? {})}|`);
  }
  hash.update('project:');
  for (const e of sortedProject) {
    hash.update(`${e.id}:${canonicalJson(e.mcpServer ?? {})}:${canonicalJson(e.mcpServerOverride ?? null)}|`);
  }
  return hash.digest('hex').slice(0, 16);
}

/** Compute a config hash for a single MCP server descriptor (for comparison). */
function serverHash(server: CapabilityEntry['mcpServer']): string {
  return createHash('sha256')
    .update(canonicalJson(server ?? {}))
    .digest('hex')
    .slice(0, 16);
}

// ── Project Check ────────────────────────────────────────────────────────────

/**
 * Check drift between global and a single project (spec §6.3).
 *
 * @param projectRoot - The project directory path
 * @param catCafeRoot - The main project (global config) path
 * @param globalConfig - Pre-read global config (optional; reads fresh if not provided)
 * @param projectConfig - Pre-read project config (optional; reads fresh if not provided)
 */
export async function checkMcpProject(
  projectRoot: string,
  catCafeRoot: string,
  globalConfig?: CapabilitiesConfig | null,
  projectConfig?: CapabilitiesConfig | null,
): Promise<McpDriftResult> {
  const gc = globalConfig ?? (await readCapabilitiesConfig(catCafeRoot));
  const pc = projectConfig ?? (await readCapabilitiesConfig(projectRoot));

  const globalMcpEntries = extractMcpEntries(gc);
  const projectMcpEntries = extractMcpEntries(pc);

  const globalMcpMap = new Map(globalMcpEntries.map((e) => [e.id, e]));
  const projectMcpMap = new Map(projectMcpEntries.map((e) => [e.id, e]));

  const issues: McpIssue[] = [];

  // 1. global-new: in global but not in project
  for (const [mcpId] of globalMcpMap) {
    if (!projectMcpMap.has(mcpId)) {
      issues.push({
        type: 'global-new',
        mcpId,
        message: `全局新增了 MCP「${mcpId}」，项目尚未同步`,
      });
    }
  }

  // 2. project-orphan: in project (non-external) but not in global
  for (const [mcpId, projectEntry] of projectMcpMap) {
    if (!globalMcpMap.has(mcpId) && projectEntry.source !== 'external') {
      issues.push({
        type: 'project-orphan',
        mcpId,
        message: `MCP「${mcpId}」在全局已不存在，疑似残留配置`,
      });
    }
  }

  // 3. config-mismatch: both have it, but global mcpServer changed
  for (const [mcpId, globalEntry] of globalMcpMap) {
    const projectEntry = projectMcpMap.get(mcpId);
    if (!projectEntry) continue;

    const globalHash = serverHash(globalEntry.mcpServer);
    // Compare against the non-override config (what the project received at last sync)
    const projectHash = serverHash(projectEntry.mcpServer);

    if (globalHash !== projectHash) {
      issues.push({
        type: 'config-mismatch',
        mcpId,
        message: `MCP「${mcpId}」项目配置与全局不一致`,
        hasOverride: projectEntry.mcpServerOverride !== undefined,
      });
    }
  }

  const summary = {
    new: issues.filter((i) => i.type === 'global-new').length,
    orphan: issues.filter((i) => i.type === 'project-orphan').length,
    mismatch: issues.filter((i) => i.type === 'config-mismatch').length,
  };

  return {
    issues,
    driftHash: computeDriftHash(globalMcpEntries, projectMcpEntries),
    summary,
  };
}

// ── Global Check ─────────────────────────────────────────────────────────────

/**
 * Check drift across all registered projects (spec §6.7).
 * Used when opening the "All MCP" tab to show aggregated banner.
 */
export async function checkMcpGlobal(catCafeRoot: string): Promise<McpGlobalDriftResult> {
  const globalConfig = await readCapabilitiesConfig(catCafeRoot);

  // #712: Unified project enumeration (governance + nested thread-derived)
  const projectPaths = await listAllProjectPaths(catCafeRoot);

  const perProject: McpGlobalDriftResult['perProject'] = [];
  let totalNew = 0;
  let totalOrphan = 0;
  let totalMismatch = 0;
  let projectsWithDrift = 0;

  for (const projectPath of projectPaths) {
    try {
      const result = await checkMcpProject(projectPath, catCafeRoot, globalConfig);
      if (result.issues.length > 0) {
        perProject.push({ path: projectPath, result });
        totalNew += result.summary.new;
        totalOrphan += result.summary.orphan;
        totalMismatch += result.summary.mismatch;
        projectsWithDrift++;
      }
    } catch (err) {
      console.warn(`[F249] drift check failed for ${projectPath}: ${(err as Error).message}`);
    }
  }

  return {
    perProject,
    totalSummary: { new: totalNew, orphan: totalOrphan, mismatch: totalMismatch, projectsWithDrift },
  };
}
