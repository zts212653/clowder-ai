import type { AgentHookDiagnostics } from './diagnostics.js';
import type { DriftResult } from './sync-targets.js';

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
  /** Optional installation diagnostics; never receives paths, content or errors. */
  diagnostics?: AgentHookDiagnostics;
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

export function aggregateStatus(targets: HealthResult[]): AgentHookHealthStatus {
  return targets.reduce<AgentHookHealthStatus>(
    (current, target) => (statusSeverity(target.status) > statusSeverity(current) ? target.status : current),
    'configured',
  );
}
