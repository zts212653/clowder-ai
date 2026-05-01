import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  projectRoot: string;
  targetRoot: string;
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

export async function getAgentHookStatus(options: AgentHookOptions): Promise<AgentHookStatusResponse> {
  const targets = buildSelectedAgentHookTargets(options);
  const results = [...targets.map(targetHealth), claudeSettingsHealth(options.targetRoot)];
  return {
    status: aggregateStatus(results),
    targets: results,
  };
}

export async function syncAgentHooks(options: AgentHookOptions): Promise<AgentHookStatusResponse> {
  for (const target of buildSelectedAgentHookTargets(options)) {
    applySync(target, false);
  }
  await syncClaudeSettings(options.targetRoot);

  const status = await getAgentHookStatus(options);
  // `hooks.json` semantic equality is canonicalized in health checks; preserve
  // a direct parse here so malformed output fails immediately after sync.
  const codex = status.targets.find((target) => target.name === 'codex-hooks');
  if (codex?.status === 'configured') {
    void canonicalJsonString(readFileSync(codex.targetPath, 'utf-8'));
  }
  return status;
}
