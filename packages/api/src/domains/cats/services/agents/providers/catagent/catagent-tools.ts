/**
 * CatAgent Path Security — F159: Native Provider Security Baseline
 *
 * Thin delegation to shared resolveWorkspacePath (workspace-security.ts).
 * Ensures a single path-validation implementation across all providers.
 *
 * Tool registry (read_file / list_files / search_content) shipped in Phase D.
 * Phase F adds gated write/exec tools under nativeToolLevel and commandPolicy.
 */

import type { CommandPolicyEntry, NativeToolLevel, TaskStatus } from '@cat-cafe/shared';
import {
  resolveWorkspaceCreatePath,
  resolveWorkspacePath,
} from '../../../../../../domains/workspace/workspace-security.js';

/** Anthropic tool schema shape (inline to avoid SDK dependency in this slice) */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: readonly string[] };
}

/** Tool permission level */
export type ToolPermission = 'allow' | 'deny';

/** A registered CatAgent tool */
export interface CatAgentTool {
  schema: ToolSchema;
  execute: (input: Record<string, unknown>) => Promise<string>;
  permission: ToolPermission;
}

export interface CatAgentToolAuditEvent {
  tool: string;
  outcome: 'ok' | 'error' | 'rejected';
  timestamp: number;
  path?: string;
  bytes?: number;
  hashBefore?: string | null;
  hashAfter?: string;
  binary?: string;
  args?: readonly string[];
  exitCode?: number | null;
  durationMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  policyEntry?: string;
  rejectReason?: string;
  invocationId?: string;
  currentTaskId?: string;
  changedFields?: readonly string[];
}

export type CatAgentToolAuditSink = (event: CatAgentToolAuditEvent) => void | Promise<void>;

export interface CatAgentCurrentTaskCallback {
  invocationId: string;
  currentTaskId: string;
  updateCurrentTaskStatus: (patch: {
    status?: TaskStatus;
    progress?: number;
    summary?: string;
  }) => void | Promise<void>;
}

export interface CatAgentScopedCallbacks {
  currentTask?: CatAgentCurrentTaskCallback;
}

export interface CatAgentToolRegistryOptions {
  nativeToolLevel?: NativeToolLevel;
  commandPolicy?: readonly CommandPolicyEntry[];
  commandTimeoutMs?: number;
  commandKillGraceMs?: number;
  audit?: CatAgentToolAuditSink;
  scopedCallbacks?: CatAgentScopedCallbacks;
}

/**
 * Resolve and validate a path within the working directory.
 * Pure delegation to resolveWorkspacePath — no error translation,
 * so upstream WorkspaceSecurityError propagates with stable error codes.
 */
export async function resolveSecurePath(workingDirectory: string, filePath: string): Promise<string> {
  return resolveWorkspacePath(workingDirectory, filePath);
}

/**
 * Resolve and validate a path intended for file creation/replacement.
 * This validates the nearest existing ancestor realpath, closing ENOENT +
 * symlink-parent escapes before write_file can create a new path.
 */
export async function resolveCreatePath(workingDirectory: string, filePath: string): Promise<string> {
  return resolveWorkspaceCreatePath(workingDirectory, filePath);
}
