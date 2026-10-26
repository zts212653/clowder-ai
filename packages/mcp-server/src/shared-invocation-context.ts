import { isAbsolute } from 'node:path';

export const SHARED_MCP_FAMILIES = ['collab', 'memory', 'signals', 'limb', 'audio', 'finance'] as const;
export type SharedMcpFamily = (typeof SHARED_MCP_FAMILIES)[number];

/** Host-owned launch projection, persisted with the original invocation principal. */
export interface SharedInvocationContext {
  readonly v: 1;
  readonly deploymentId: string;
  readonly workspaceRoot: string;
  readonly dataDir: string;
  readonly allowedWorkspaceDirs: readonly string[];
  readonly capabilityRoot: string;
  readonly families: readonly SharedMcpFamily[];
  readonly desktopMode?: string;
}

export function parseSharedInvocationContext(value: unknown): SharedInvocationContext {
  if (!value || typeof value !== 'object') throw new Error('Shared MCP context is required');
  const context = value as Partial<SharedInvocationContext>;
  if (
    context.v !== 1 ||
    !context.deploymentId?.trim() ||
    !context.workspaceRoot ||
    !isAbsolute(context.workspaceRoot) ||
    !context.dataDir ||
    !isAbsolute(context.dataDir) ||
    !context.capabilityRoot ||
    !isAbsolute(context.capabilityRoot) ||
    !Array.isArray(context.allowedWorkspaceDirs) ||
    !context.allowedWorkspaceDirs.length ||
    !context.allowedWorkspaceDirs.every((root) => typeof root === 'string' && isAbsolute(root)) ||
    !Array.isArray(context.families) ||
    !context.families.every((family) => SHARED_MCP_FAMILIES.includes(family)) ||
    (context.desktopMode !== undefined &&
      !['fable-phase0', 'cloud-pro-phase0', 'live-companion'].includes(context.desktopMode))
  )
    throw new Error('Shared MCP context has invalid workspace, roots or policy');
  return Object.freeze({
    v: 1,
    deploymentId: context.deploymentId,
    workspaceRoot: context.workspaceRoot,
    dataDir: context.dataDir,
    capabilityRoot: context.capabilityRoot,
    allowedWorkspaceDirs: Object.freeze([...context.allowedWorkspaceDirs]),
    families: Object.freeze([...new Set(context.families)]),
    ...(context.desktopMode ? { desktopMode: context.desktopMode } : {}),
  });
}
