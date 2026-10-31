import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { AGY_NATIVE_READ_TOOLS, AGY_NATIVE_TOOLS } from './agy-native-tools.js';

export type AgyNativePermissionMode = 'request-review' | 'always-proceed';

/** Translate the operator permission choice; task custody and callback authority remain canonical. */
export function buildAgyNativePolicy(input: { workspaceRoot: string; autoApprove?: boolean; readOnly?: boolean }) {
  const root = realpathSync(input.workspaceRoot);
  if (!lstatSync(root).isDirectory()) throw new Error('AGY workspace root must be a directory');
  const autoApprove = input.autoApprove === true && !input.readOnly;
  const permissionMode: AgyNativePermissionMode = autoApprove ? 'always-proceed' : 'request-review';
  return {
    workspaceRoot: root,
    permissionMode,
    agentTools: input.readOnly ? AGY_NATIVE_READ_TOOLS : AGY_NATIVE_TOOLS,
    cliArgs: autoApprove ? ['--dangerously-skip-permissions'] : ['--sandbox'],
    settings: {
      enableTerminalSandbox: !autoApprove,
      toolPermission: permissionMode,
      allowNonWorkspaceAccess: autoApprove,
      permissions: {
        allow: input.readOnly
          ? []
          : [...(autoApprove ? ['write_file(*)', 'command(*)', 'unsandboxed(*)'] : []), 'mcp(*)'],
        deny: input.readOnly ? ['command(*)', 'unsandboxed(*)', 'write_file(*)', 'mcp(*)'] : [],
      },
    },
  };
}

export type AgyNativeWorkspacePreflight =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'workspace_executable_customization';
      readonly path: string;
    };

/** Workspace hooks/MCP/agents execute or rewrite model/tool behavior before host policy can act. */
export function preflightAgyNativeWorkspace(workspaceRoot: string): AgyNativeWorkspacePreflight {
  const root = realpathSync(workspaceRoot);
  const entries = readdirSync(root);
  // Executable customization takes precedence: accepting sensitive content must
  // never hide a hook, agent, plugin, skill registry, or workspace MCP binding.
  // Match names explicitly: the rejection policy must not depend on the host
  // filesystem folding case, and Linux can contain several aliases at once.
  for (const entry of entries.filter((name) => name.toLowerCase() === '.agents')) {
    const agentsDir = join(root, entry);
    if (!lstatSync(agentsDir).isDirectory()) {
      return { ok: false, reason: 'workspace_executable_customization', path: agentsDir };
    }
    const unsafe = readdirSync(agentsDir).find((name) =>
      ['hooks.json', 'agents', 'plugins', 'skills.json', 'mcp_config.json'].includes(name.toLowerCase()),
    );
    if (unsafe) {
      return { ok: false, reason: 'workspace_executable_customization', path: join(agentsDir, unsafe) };
    }
  }
  return { ok: true };
}
