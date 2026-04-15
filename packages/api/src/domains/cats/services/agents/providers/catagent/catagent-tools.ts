/**
 * CatAgent Path Security — F159: Native Provider Security Baseline
 *
 * Thin delegation to shared resolveWorkspacePath (workspace-security.ts).
 * Ensures a single path-validation implementation across all providers.
 *
 * Tool registry (read_file / list_files / search_content) ships in Phase D.
 * ADR-001 F159 boundary: no write/edit/delete, no shell/exec, no network tools.
 */

import { resolveWorkspacePath } from '../../../../../../domains/workspace/workspace-security.js';

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

/**
 * Resolve and validate a path within the working directory.
 * Pure delegation to resolveWorkspacePath — no error translation,
 * so upstream WorkspaceSecurityError propagates with stable error codes.
 */
export async function resolveSecurePath(workingDirectory: string, filePath: string): Promise<string> {
  return resolveWorkspacePath(workingDirectory, filePath);
}
