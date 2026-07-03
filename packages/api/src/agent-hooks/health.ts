import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { checkMcpProject, type McpDriftResult, type McpIssue } from '../mcp/mcp-drift-detector.js';
import { syncMcpDrift } from '../mcp/mcp-drift-resolver.js';
import { computeSkillDrift } from '../routes/skills-drift.js';
import { syncDrift } from '../skills/drift-resolver.js';
import { resolveStartupProjectRoot } from '../utils/startup-root.js';
import { claudeSettingsHealth, syncClaudeSettings } from './claude-settings.js';
import {
  applySync,
  buildAgentHookTargets,
  canonicalJsonString,
  checkDrift,
  type DriftResult,
  type SyncTarget,
  selectAgentHookTargets,
} from './sync-targets.js';

export type AgentHookHealthStatus = 'configured' | 'missing' | 'stale' | 'unsupported' | 'error';

export interface AgentHookDiffSummary {
  kind: 'text' | 'json';
  message: string;
  line?: number;
  fields?: string[];
}

export interface HealthResult extends DriftResult {
  status: AgentHookHealthStatus;
  reason: string;
  diff?: AgentHookDiffSummary;
}

export interface AgentHookStatusResponse {
  status: AgentHookHealthStatus;
  targets: HealthResult[];
}

export interface AgentHookOptions {
  /** Install/root repo — source for hook templates (.claude/hooks/). */
  projectRoot: string;
  targetRoot: string;
  /**
   * When the thread targets an external project, this is that project's path.
   * Skill/MCP health and sync operate against this root instead of projectRoot.
   * Defaults to projectRoot when not set (root project thread).
   */
  capabilityProjectRoot?: string;
  /**
   * Fail-closed: only `true` enables capability-level mutations (skill/MCP sync).
   * Omitted / undefined / false → hook file sync only, no capability writes.
   * Set by the route layer after passing the owner gate (#1049 P2-4).
   */
  ownerAuthorized?: boolean;
}

type JsonObject = Record<string, unknown>;

function buildSelectedAgentHookTargets(options: AgentHookOptions): SyncTarget[] {
  return selectAgentHookTargets(buildAgentHookTargets(options));
}

function statusSeverity(status: AgentHookHealthStatus): number {
  switch (status) {
    case 'error':
      return 5;
    case 'stale':
      return 4;
    case 'missing':
      return 3;
    case 'unsupported':
      return 2;
    case 'configured':
      return 1;
  }
}

function aggregateStatus(targets: HealthResult[]): AgentHookHealthStatus {
  return targets.reduce<AgentHookHealthStatus>(
    (current, target) => (statusSeverity(target.status) > statusSeverity(current) ? target.status : current),
    'configured',
  );
}

function mapDriftResult(result: DriftResult): AgentHookHealthStatus {
  if (!result.drifted) return 'configured';
  return result.reason === 'target file does not exist' ? 'missing' : 'stale';
}

function buildTextDiff(current: string, rendered: string): AgentHookDiffSummary {
  const currentLines = current.split(/\r?\n/);
  const renderedLines = rendered.split(/\r?\n/);
  const max = Math.max(currentLines.length, renderedLines.length);
  for (let i = 0; i < max; i += 1) {
    if (currentLines[i] !== renderedLines[i]) {
      return {
        kind: 'text',
        line: i + 1,
        message: `first difference at line ${i + 1}`,
      };
    }
  }
  return { kind: 'text', message: 'content differs' };
}

function flattenJson(value: unknown, prefix = ''): Map<string, string> {
  const result = new Map<string, string>();
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      for (const [key, nested] of flattenJson(item, `${prefix}[${index}]`)) result.set(key, nested);
    });
    return result;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as JsonObject)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      for (const [nestedKey, nestedValue] of flattenJson(nested, nextPrefix)) result.set(nestedKey, nestedValue);
    }
    return result;
  }
  result.set(prefix === '' ? '<root>' : prefix, JSON.stringify(value));
  return result;
}

function buildJsonDiff(current: string, rendered: string): AgentHookDiffSummary {
  try {
    const currentFlat = flattenJson(JSON.parse(current));
    const renderedFlat = flattenJson(JSON.parse(rendered));
    const keys = new Set([...currentFlat.keys(), ...renderedFlat.keys()]);
    const fields = [...keys].filter((key) => currentFlat.get(key) !== renderedFlat.get(key)).slice(0, 8);
    return {
      kind: 'json',
      fields,
      message: fields.length > 0 ? `changed fields: ${fields.join(', ')}` : 'json content differs',
    };
  } catch {
    return { kind: 'json', message: 'json parse failed while building diff' };
  }
}

function buildDiff(target: SyncTarget): AgentHookDiffSummary | undefined {
  const current = readFileSync(target.targetPath, 'utf-8');
  const rendered = target.render();
  if (target.contentKind === 'json') return buildJsonDiff(current, rendered);
  return buildTextDiff(current, rendered);
}

function buildMissingDiff(target: SyncTarget): AgentHookDiffSummary {
  return {
    kind: target.contentKind === 'json' ? 'json' : 'text',
    message: 'target file is missing',
  };
}

function targetHealth(target: SyncTarget): HealthResult {
  try {
    if (target.name === 'codex-hooks' && !existsSync(dirname(target.targetPath)) && !existsSync(target.targetPath)) {
      return {
        name: target.name,
        drifted: false,
        status: 'unsupported',
        targetPath: target.targetPath,
        reason: 'Codex config directory does not exist',
      };
    }

    const drift = checkDrift(target);
    const status = mapDriftResult(drift);
    return {
      name: target.name,
      drifted: drift.drifted,
      status,
      targetPath: target.targetPath,
      reason: drift.reason === undefined ? 'configured' : drift.reason,
      diff: status === 'stale' ? buildDiff(target) : status === 'missing' ? buildMissingDiff(target) : undefined,
    };
  } catch (error) {
    return {
      name: target.name,
      drifted: false,
      status: 'error',
      targetPath: target.targetPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Skill & MCP drift helpers (#1049 Step 3) ────────────────────────────────

async function checkSkillHealth(projectRoot: string): Promise<HealthResult> {
  try {
    // Skip skill drift check if the project has no capabilities.json —
    // uninitialised projects have no skill config to drift against.
    if (!existsSync(join(projectRoot, '.cat-cafe', 'capabilities.json'))) {
      return {
        name: 'skills',
        drifted: false,
        status: 'configured',
        targetPath: '',
        reason: 'no project capabilities',
      };
    }
    const ctx = await computeSkillDrift(projectRoot);
    if (!ctx) {
      return { name: 'skills', drifted: false, status: 'configured', targetPath: '', reason: 'no skill source' };
    }
    const { newSkills, stale, conflicts } = ctx.drift;
    const total = newSkills.length + stale.length + conflicts.length;
    if (total === 0) {
      return { name: 'skills', drifted: false, status: 'configured', targetPath: '', reason: 'configured' };
    }
    const parts: string[] = [];
    if (newSkills.length) parts.push(`${newSkills.length} new`);
    if (stale.length) parts.push(`${stale.length} stale`);
    if (conflicts.length) parts.push(`${conflicts.length} conflicts`);
    return { name: 'skills', drifted: true, status: 'stale', targetPath: '', reason: parts.join(', ') };
  } catch {
    return { name: 'skills', drifted: false, status: 'configured', targetPath: '', reason: 'configured' };
  }
}

/**
 * Filter orphan issues based on global config validity.
 *
 * When the global config was successfully parsed, only plugin-owned orphans
 * are filtered (non-plugin orphans are real drift).  When the global config
 * is missing, malformed, or otherwise unreadable (readCapabilitiesConfig
 * returned null), ALL orphans are filtered to avoid destructive sync — an
 * empty global map makes every project MCP look like an orphan.
 *
 * @param globalConfigValid — true when readCapabilitiesConfig returned a
 *   non-null result for the startup root.
 */
function filterOrphanIssues(drift: McpDriftResult, globalConfigValid: boolean): McpIssue[] {
  return drift.issues.filter((i) => {
    if (i.type !== 'project-orphan') return true;
    // Global config invalid → orphan detection unreliable, skip all
    if (!globalConfigValid) return false;
    // Global config valid → only filter plugin-owned orphans
    return !i.pluginId;
  });
}

async function checkMcpHealth(projectRoot: string): Promise<HealthResult> {
  try {
    // Skip MCP drift check if the project has no capabilities.json —
    // uninitialised projects have no MCP config to drift against.
    if (!existsSync(join(projectRoot, '.cat-cafe', 'capabilities.json'))) {
      return { name: 'mcp', drifted: false, status: 'configured', targetPath: '', reason: 'no project capabilities' };
    }
    const startupRoot = resolveStartupProjectRoot();
    const globalConfig = await readCapabilitiesConfig(startupRoot);
    const drift = await checkMcpProject(projectRoot, startupRoot, globalConfig);
    const actionableIssues = filterOrphanIssues(drift, globalConfig !== null);
    if (actionableIssues.length === 0) {
      return { name: 'mcp', drifted: false, status: 'configured', targetPath: '', reason: 'configured' };
    }
    return {
      name: 'mcp',
      drifted: true,
      status: 'stale',
      targetPath: '',
      reason: `${actionableIssues.length} drift issue${actionableIssues.length > 1 ? 's' : ''}`,
    };
  } catch {
    return { name: 'mcp', drifted: false, status: 'configured', targetPath: '', reason: 'configured' };
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function getAgentHookStatus(options: AgentHookOptions): Promise<AgentHookStatusResponse> {
  const targets = buildSelectedAgentHookTargets(options);
  const hookResults = [...targets.map(targetHealth), claudeSettingsHealth(options.targetRoot)];

  // #1049 Step 3: unified health check — hooks + skills + MCPs
  // capabilityProjectRoot targets the thread's project; projectRoot stays
  // the install repo for hook templates.
  const capRoot = options.capabilityProjectRoot ?? options.projectRoot;
  const [skillHealth, mcpHealth] = await Promise.all([checkSkillHealth(capRoot), checkMcpHealth(capRoot)]);
  const results = [...hookResults, skillHealth, mcpHealth];

  return {
    status: aggregateStatus(results),
    targets: results,
  };
}

export async function syncAgentHooks(options: AgentHookOptions): Promise<AgentHookStatusResponse> {
  // Sync hooks (existing behavior)
  for (const target of buildSelectedAgentHookTargets(options)) {
    applySync(target, false);
  }
  await syncClaudeSettings(options.targetRoot);

  // #1049 Step 3: sync skills + MCPs with keep-project policy.
  // Health-triggered sync preserves user-customized content (skill symlinks,
  // MCP overrides), unlike Console manual sync which uses use-global.
  // Guards:
  //   1. ownerAuthorized — capability mutations require owner auth (P2-4 defense-in-depth)
  //   2. hasCapabilities — uninitialised/malformed projects skip (no side-effect creation).
  //      Parse-validates the project config, not just file existence — malformed JSON
  //      could cause skill/MCP sync to treat the project as empty and wipe entries.
  // capabilityProjectRoot targets the thread's project for skill/MCP sync;
  // projectRoot stays the install repo for hook templates.
  const capRoot = options.capabilityProjectRoot ?? options.projectRoot;
  const projectConfig = options.ownerAuthorized === true ? await readCapabilitiesConfig(capRoot) : null;
  const hasCapabilities = projectConfig !== null;

  if (hasCapabilities) {
    // Read global config once — both skill and MCP sync compare project
    // against global.  When global is unreadable (missing / malformed),
    // every project entry looks like an orphan; skip destructive sync
    // paths to avoid wiping valid project config.
    const startupRoot = resolveStartupProjectRoot();
    const globalConfig = await readCapabilitiesConfig(startupRoot);

    if (globalConfig !== null) {
      try {
        const ctx = await computeSkillDrift(capRoot);
        if (ctx) {
          const { newSkills, stale, conflicts } = ctx.drift;
          if (newSkills.length + stale.length + conflicts.length > 0) {
            await syncDrift(
              ctx.effectiveRoot,
              ctx.skillsSource,
              ctx.mountRules,
              ctx.drift,
              ctx.syncOpts,
              'keep-project',
            );
          }
        }
      } catch {
        /* skill sync failure should not block hook sync result */
      }
    }

    try {
      const drift = await checkMcpProject(capRoot, startupRoot, globalConfig);
      const nonDestructiveIssues = filterOrphanIssues(drift, globalConfig !== null);
      if (nonDestructiveIssues.length > 0) {
        const safeDrift = { ...drift, issues: nonDestructiveIssues };
        await syncMcpDrift(capRoot, startupRoot, safeDrift, undefined, 'keep-project');
      }
    } catch {
      /* MCP sync failure should not block hook sync result */
    }
  }

  const status = await getAgentHookStatus(options);
  // `hooks.json` semantic equality is canonicalized in health checks; preserve
  // a direct parse here so malformed output fails immediately after sync.
  const codex = status.targets.find((target) => target.name === 'codex-hooks');
  if (codex?.status === 'configured') {
    void canonicalJsonString(readFileSync(codex.targetPath, 'utf-8'));
  }
  return status;
}
