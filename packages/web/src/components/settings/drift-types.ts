/**
 * Shared types for the unified drift detection system.
 * F249: Both Skill and MCP drift use the same check function, endpoint, and UI components.
 */

/** The capability type being checked for drift. */
export type DriftType = 'skill' | 'mcp';

/** Normalized drift issue — covers both Skill and MCP issue types. */
export interface DriftIssue {
  /** Identifier: skill name for skills, server ID for MCP. */
  id: string;
  /** Issue classification (skill: conflict/mount-missing/… | mcp: global-new/project-orphan/…). */
  issueType: string;
  /** Human-readable description (backend-generated). */
  message: string;
  /** Skill-specific: which mount point is affected. */
  mountPoint?: string;
  /** MCP-specific: project has a custom override. */
  hasOverride?: boolean;
}

/** One scope (global or a project) with its backend-computed issue list. */
export interface ScopeIssues {
  /** 'global' or the project path. */
  key: string;
  /** Display label, e.g. '全局' or the project name. */
  label: string;
  /** Project path; undefined for the global scope. */
  path?: string;
  issues: DriftIssue[];
}

/** Backend response shape from POST /api/drift/check. */
export interface DriftCheckResult {
  issues: DriftIssue[];
  driftHash: string;
}

/** Issue-type label map (covers both Skill and MCP issue types). */
export const DRIFT_ISSUE_LABELS: Record<string, string> = {
  // Skill issue types
  conflict: '冲突',
  'mount-missing': '挂载缺失',
  unregistered: '未注册',
  phantom: '幽灵',
  'config-new': '新配置',
  'config-orphan': '配置残留',
  'stale-mount': '过期挂载',
  // MCP issue types
  'global-new': '全局新增',
  'project-orphan': '残留配置',
  'config-mismatch': '配置不一致',
};

/** Display label for the drift type. */
export function driftTypeLabel(type: DriftType): string {
  return type === 'skill' ? 'Skill' : 'MCP';
}
