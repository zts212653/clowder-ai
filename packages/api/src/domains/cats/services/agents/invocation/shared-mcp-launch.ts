import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSharedInvocationContext,
  type SharedInvocationContext,
} from '@cat-cafe/mcp-server/dist/shared-invocation-context.js';
import { resolveBinaryRoot } from '../../../../../config/capabilities/capability-orchestrator.js';
import { resolveInvokeCapabilityRoot } from '../../../../../config/capabilities/invoke-capability-root.js';
import { resolveConfiguredMemberMcpFamilies } from '../../../../../config/capabilities/member-mcp-families.js';
import { resolveCatCafeDataRoot } from '../../../../../utils/cli-process-ownership.js';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import { resolveDefaultThreadWorkspace } from './default-thread-workspace.js';

export function sharedMcpDeploymentId(apiUrl: string): string {
  return process.env.CAT_CAFE_DEPLOYMENT_ID?.trim() || `local:${new URL(apiUrl).port}`;
}

/** Read the Host launch decision once. No request/model field can add a root or family. */
export async function prepareSharedMcpLaunch(input: {
  catId: string;
  apiUrl: string;
  workingDirectory?: string;
  transport?: string;
}): Promise<SharedInvocationContext> {
  const mode = input.transport ?? process.env.CAT_CAFE_MCP_TRANSPORT ?? 'shared';
  if (!['shared', 'stdio'].includes(mode)) throw new Error('Invalid CAT_CAFE_MCP_TRANSPORT');
  const workspace = input.workingDirectory
    ? { ok: true as const, path: resolve(input.workingDirectory) }
    : await resolveDefaultThreadWorkspace();
  if (!workspace.ok) throw new Error(workspace.error);
  const roots = process.env.ALLOWED_WORKSPACE_DIRS?.split(/[:,]/)
    .map((root) => root.trim())
    .filter(Boolean);
  const binaryRoot = resolveBinaryRoot(findMonorepoRoot(dirname(fileURLToPath(import.meta.url))));
  const capabilityRoot = await resolveInvokeCapabilityRoot(binaryRoot);
  const home = homedir();
  return parseSharedInvocationContext({
    v: 1,
    deploymentId: sharedMcpDeploymentId(input.apiUrl),
    workspaceRoot: workspace.path,
    dataDir: resolveCatCafeDataRoot(),
    allowedWorkspaceDirs: roots?.length
      ? roots.map((root) =>
          resolve(workspace.path, root === '~' ? home : root.startsWith('~/') ? join(home, root.slice(2)) : root),
        )
      : [workspace.path],
    capabilityRoot,
    families: await resolveConfiguredMemberMcpFamilies(capabilityRoot, input.catId, workspace.path),
  });
}
