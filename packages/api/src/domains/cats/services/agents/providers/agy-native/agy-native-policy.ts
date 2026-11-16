import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { AGY_NATIVE_READ_TOOLS, AGY_NATIVE_TOOLS } from './agy-native-tools.js';

export type AgyNativePermissionMode = 'request-review' | 'always-proceed';

/** Translate the operator permission choice; task custody and callback authority remain canonical. */
export function buildAgyNativePolicy(input: {
  workspaceRoot: string;
  autoApprove?: boolean;
  readOnly?: boolean;
  pluginServerName?: string;
}) {
  const root = realpathSync(input.workspaceRoot);
  if (!lstatSync(root).isDirectory()) throw new Error('AGY workspace root must be a directory');
  const member = input.pluginServerName !== undefined;
  const autoApprove = input.autoApprove === true && !input.readOnly && !member;
  const permissionMode: AgyNativePermissionMode = autoApprove ? 'always-proceed' : 'request-review';
  return {
    workspaceRoot: root,
    permissionMode,
    agentTools: member ? [] : input.readOnly ? AGY_NATIVE_READ_TOOLS : AGY_NATIVE_TOOLS,
    cliArgs: autoApprove ? ['--dangerously-skip-permissions'] : ['--sandbox'],
    settings: {
      enableTerminalSandbox: !autoApprove,
      toolPermission: permissionMode,
      allowNonWorkspaceAccess: autoApprove,
      permissions: {
        allow: input.readOnly
          ? []
          : [...(autoApprove ? ['write_file(*)', 'command(*)', 'unsandboxed(*)'] : []), 'mcp(*)'],
        deny: input.readOnly
          ? ['command(*)', 'unsandboxed(*)', 'write_file(*)', 'mcp(*)']
          : member
            ? ['command(*)', 'unsandboxed(*)', 'write_file(*)']
            : [],
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
export function preflightAgyNativeWorkspace(
  workspaceRoot: string,
  options?: { readonly hostAgentName?: string },
): AgyNativeWorkspacePreflight {
  const root = realpathSync(workspaceRoot);
  const entries = readdirSync(root);
  const hostAgentLower = options?.hostAgentName?.toLowerCase();
  for (const entry of entries.filter((name) => name.toLowerCase() === '.agents')) {
    const agentsDir = join(root, entry);
    if (!lstatSync(agentsDir).isDirectory()) {
      return { ok: false, reason: 'workspace_executable_customization', path: agentsDir };
    }
    const children = readdirSync(agentsDir);
    if (hostAgentLower) {
      for (const agentsSub of children.filter((name) => name.toLowerCase() === 'agents')) {
        const subPath = join(agentsDir, agentsSub);
        try {
          if (lstatSync(subPath).isDirectory()) {
            const shadowed = readdirSync(subPath).find((name) => name.toLowerCase() === hostAgentLower);
            if (shadowed) {
              return { ok: false, reason: 'workspace_executable_customization', path: join(subPath, shadowed) };
            }
          }
        } catch {
          return { ok: false, reason: 'workspace_executable_customization', path: subPath };
        }
      }
    }
    const unsafe = children.find((name) =>
      ['hooks.json', 'agents', 'plugins', 'skills.json', 'mcp_config.json'].includes(name.toLowerCase()),
    );
    if (unsafe) {
      return { ok: false, reason: 'workspace_executable_customization', path: join(agentsDir, unsafe) };
    }
  }
  return { ok: true };
}
