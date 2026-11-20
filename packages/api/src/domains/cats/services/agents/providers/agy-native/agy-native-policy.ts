import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AGY_NATIVE_READ_TOOLS, AGY_NATIVE_TOOLS } from './agy-native-tools.js';

export type AgyNativePermissionMode = 'request-review' | 'always-proceed';

/** Translate the operator permission choice; task custody and callback authority remain canonical. */
export function buildAgyNativePolicy(input: {
  workspaceRoot: string;
  autoApprove?: boolean;
  readOnly?: boolean;
  watcher?: boolean;
  pluginServerName?: string;
  allowWorkspaceWrites?: boolean;
  interactiveApproval?: boolean;
}) {
  const root = realpathSync(input.workspaceRoot);
  if (!lstatSync(root).isDirectory()) throw new Error('AGY workspace root must be a directory');
  const member = input.pluginServerName !== undefined || input.watcher === true;
  const autoApprove = input.autoApprove === true && !input.readOnly && !member;
  const permissionMode: AgyNativePermissionMode = autoApprove ? 'always-proceed' : 'request-review';
  const reviewAllowsWrite =
    !autoApprove && !input.readOnly && !member && Boolean(input.allowWorkspaceWrites || input.interactiveApproval);
  const reviewAllowsCommand = !autoApprove && !input.readOnly && !member && Boolean(input.interactiveApproval);
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
          : [
              ...(autoApprove ? ['write_file(*)', 'command(*)', 'unsandboxed(*)'] : []),
              ...(reviewAllowsWrite ? ['write_file(*)'] : []),
              ...(reviewAllowsCommand ? ['command(*)'] : []),
              'mcp(*)',
            ],
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

function withinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function resolvePhysicalInsideRoot(root: string, relEntry: string): boolean {
  if (!relEntry || isAbsolute(relEntry)) return false;
  const logical = resolve(root, relEntry);
  if (!withinRoot(root, logical)) return false;
  let parent = logical;
  const suffix: string[] = [];
  while (!existsSync(parent) && dirname(parent) !== parent) {
    suffix.unshift(basename(parent));
    parent = dirname(parent);
  }
  try {
    if (lstatSync(parent).isSymbolicLink()) {
      const target = realpathSync(parent);
      if (!withinRoot(root, target)) return false;
    }
    const physical = join(realpathSync(parent), ...suffix);
    return withinRoot(root, physical);
  } catch {
    return false;
  }
}

function isSafeWorkspaceSkillsJson(root: string, filePath: string): boolean {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 256 * 1024) return false;
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!raw) return true;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const obj = parsed as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== 'entries' && key !== 'inherits') return false;
      const list = obj[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) return false;
      for (const item of list) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const entryPath = (item as Record<string, unknown>).path;
        if (typeof entryPath !== 'string' || !resolvePhysicalInsideRoot(root, entryPath)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function isSafeWorkspacePluginDir(pluginDir: string, allowExecutable: boolean): boolean {
  try {
    const stat = lstatSync(pluginDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const children = readdirSync(pluginDir);
    let disabled = false;
    const manifestName = children.find((c) => c.toLowerCase() === 'plugin.json');
    if (manifestName) {
      const manifestPath = join(pluginDir, manifestName);
      const mStat = lstatSync(manifestPath);
      if (mStat.isSymbolicLink() || !mStat.isFile()) return false;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      disabled = manifest?.disabled === true;
    }
    for (const child of children) {
      const cPath = join(pluginDir, child);
      if (lstatSync(cPath).isSymbolicLink()) return false;
      const cLower = child.toLowerCase();
      if ((cLower === 'hooks.json' || cLower === 'mcp_config.json') && !disabled && !allowExecutable) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Workspace hooks/MCP/agents execute or rewrite model/tool behavior before host policy can act. */
export function preflightAgyNativeWorkspace(
  workspaceRoot: string,
  options?: { readonly hostAgentName?: string; readonly allowWorkspaceExecutableConfig?: boolean },
): AgyNativeWorkspacePreflight {
  const root = realpathSync(workspaceRoot);
  const entries = readdirSync(root);
  const hostAgentLower = options?.hostAgentName?.toLowerCase();
  const allowExecutable = options?.allowWorkspaceExecutableConfig === true;
  for (const entry of entries.filter((name) => name.toLowerCase() === '.agents')) {
    const agentsDir = join(root, entry);
    const dirStat = lstatSync(agentsDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      return { ok: false, reason: 'workspace_executable_customization', path: agentsDir };
    }
    for (const child of readdirSync(agentsDir)) {
      const childPath = join(agentsDir, child);
      const lower = child.toLowerCase();
      let childStat: ReturnType<typeof lstatSync>;
      try {
        childStat = lstatSync(childPath);
      } catch {
        return { ok: false, reason: 'workspace_executable_customization', path: childPath };
      }
      if (
        ['hooks.json', 'mcp_config.json', 'plugins.json', 'agents', 'plugins', 'skills.json'].includes(lower) &&
        childStat.isSymbolicLink()
      ) {
        return { ok: false, reason: 'workspace_executable_customization', path: childPath };
      }
      if (lower === 'hooks.json' || lower === 'mcp_config.json' || lower === 'plugins.json') {
        if (!childStat.isFile() || !allowExecutable) {
          return { ok: false, reason: 'workspace_executable_customization', path: childPath };
        }
        continue;
      }
      if (lower === 'agents') {
        if (!childStat.isDirectory()) {
          return { ok: false, reason: 'workspace_executable_customization', path: childPath };
        }
        const subAgents = readdirSync(childPath);
        if (subAgents.length === 0) continue;
        if (!hostAgentLower) {
          return { ok: false, reason: 'workspace_executable_customization', path: childPath };
        }
        for (const sub of subAgents) {
          const subPath = join(childPath, sub);
          if (lstatSync(subPath).isSymbolicLink() || sub.toLowerCase() === hostAgentLower) {
            return { ok: false, reason: 'workspace_executable_customization', path: subPath };
          }
        }
        continue;
      }
      if (lower === 'skills.json') {
        if (!isSafeWorkspaceSkillsJson(root, childPath)) {
          return { ok: false, reason: 'workspace_executable_customization', path: childPath };
        }
        continue;
      }
      if (lower === 'plugins') {
        if (!childStat.isDirectory()) {
          return { ok: false, reason: 'workspace_executable_customization', path: childPath };
        }
        for (const pluginName of readdirSync(childPath)) {
          const pluginPath = join(childPath, pluginName);
          if (!isSafeWorkspacePluginDir(pluginPath, allowExecutable)) {
            return { ok: false, reason: 'workspace_executable_customization', path: pluginPath };
          }
        }
      }
    }
  }
  return { ok: true };
}
