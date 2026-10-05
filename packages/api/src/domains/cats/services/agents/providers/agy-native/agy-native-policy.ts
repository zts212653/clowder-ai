import { lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** AGY's declarative agent tool set. MCP tools are added by the CLI from host-owned config. */
export const AGY_NATIVE_FILE_TOOLS = [
  'view_file',
  'list_dir',
  'grep_search',
  'find_by_name',
  'write_to_file',
  'replace_file_content',
] as const;

export const AGY_NATIVE_HOST_MCP_SERVERS = ['cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals'] as const;
const P1_HOST_MCP_SERVERS = new Set<string>(AGY_NATIVE_HOST_MCP_SERVERS);
const P1_MCP_CALLBACK_ROUTES = new Map<string, string>([
  ['cat-cafe-collab/cat_cafe_get_thread_context', 'GET /api/callbacks/thread-context'],
  ['cat-cafe-collab/cat_cafe_post_message', 'POST /api/callbacks/post-message'],
  ['cat-cafe-collab/cat_cafe_run_task_test', 'GET /api/callbacks/native-test-grant'],
]);

export interface AgyNativePolicyInput {
  workspaceRoot: string;
  /** Exact files approved for this task; a directory grant would include executable .agents aliases. */
  writableFiles: readonly string[];
  /** Exact requested pairs. The caller must also verify each server's executable is host-owned. */
  mcpTools: readonly string[];
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

const PROTECTED_CODING_BASENAMES = new Set([
  'package.json',
  'cat-config.json',
  'cat-template.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
  '.npmrc',
  '.gitattributes',
  '.gitmodules',
  '.netrc',
  '.pypirc',
  'biome.json',
  'biome.jsonc',
  'turbo.json',
  'dockerfile',
  'makefile',
]);

function isProtectedCodingPath(segments: readonly string[]): boolean {
  const lower = segments.map((segment) => segment.toLowerCase());
  const filename = lower.at(-1) ?? '';
  return (
    lower.some((segment) => ['.ssh', '.aws', '.github', '.config', '.cat-cafe'].includes(segment)) ||
    filename === '.env' ||
    filename.startsWith('.env.') ||
    PROTECTED_CODING_BASENAMES.has(filename) ||
    /^tsconfig(?:\..+)?\.json$/.test(filename) ||
    /^(?:vitest|jest|vite|webpack|rollup|babel|eslint|next|postcss|playwright)\.config\..+$/.test(filename)
  );
}

function exactWritableFile(root: string, supplied: string): string {
  // Permission rules use glob-like syntax; a literal filename can otherwise widen an exact grant.
  if (!supplied.trim() || [...supplied].some((character) => '()[]{}*?\\\r\n\0'.includes(character))) {
    throw new Error('unsafe AGY writable file path');
  }
  const target = resolve(root, supplied);
  if (isOutside(root, target)) throw new Error('AGY writable file must be inside the workspace');
  const segments = relative(root, target).split(sep);
  if (segments.some((segment) => ['.agents', '.git', '.gemini'].includes(segment.toLowerCase()))) {
    throw new Error('unsafe AGY executable customization or Git path');
  }
  if (['agents.md', 'gemini.md'].includes(segments.at(-1)?.toLowerCase() ?? '')) {
    throw new Error('unsafe AGY workspace rule file');
  }
  if (isProtectedCodingPath(segments)) throw new Error('unsafe AGY executable or sensitive coding target');

  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = lstatIfPresent(current);
    if (stat?.isSymbolicLink()) throw new Error('AGY writable file path contains a symlink');
    if (index < segments.length - 1 && !stat?.isDirectory()) {
      throw new Error('AGY writable file parent must already be a directory');
    }
    if (index === segments.length - 1 && stat?.isDirectory()) {
      throw new Error('AGY writable target must be a file');
    }
  }
  return target;
}

function exactHostMcpTool(value: string): string {
  const [server] = value.split('/');
  if (!/^cat-cafe-[a-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(value) || !server || !P1_HOST_MCP_SERVERS.has(server)) {
    throw new Error('AGY MCP grant must name an exact trusted Clowder AI server/tool');
  }
  if (!P1_MCP_CALLBACK_ROUTES.has(value)) throw new Error('AGY MCP tool has no exact callback scope');
  return value;
}

/** The same host-authored MCP grant constrains the server-side invocation token. */
export function callbackPolicyForAgyNativeMcpTools(mcpTools: readonly string[]) {
  return {
    mode: 'callback_allowlist' as const,
    allowedCallbackRoutes: [...new Set(mcpTools.map((tool) => P1_MCP_CALLBACK_ROUTES.get(exactHostMcpTool(tool))))]
      .filter((route): route is string => route !== undefined)
      .sort(),
  };
}

/** Build task-scoped grants. Spawn wiring must enforce these settings and validate MCP bindings. */
export function buildAgyNativePolicy(input: AgyNativePolicyInput) {
  const root = realpathSync(input.workspaceRoot);
  if (!lstatSync(root).isDirectory()) throw new Error('AGY workspace root must be a directory');
  const files = [...new Set(input.writableFiles.map((file) => exactWritableFile(root, file)))];
  const mcpTools = [...new Set(input.mcpTools.map(exactHostMcpTool))];
  return {
    workspaceRoot: root,
    grantedMcpTools: mcpTools,
    agentTools: AGY_NATIVE_FILE_TOOLS,
    cliArgs: ['--sandbox'] as const,
    settings: {
      enableTerminalSandbox: true,
      toolPermission: 'request-review' as const,
      allowNonWorkspaceAccess: false,
      permissions: {
        allow: [...files.map((file) => `write_file(${file})`), ...mcpTools.map((tool) => `mcp(${tool})`)],
        deny: ['command(*)', 'unsandboxed(*)', 'write_file(.agents/)', 'write_file(.git/)'],
      },
    },
  };
}

export type AgyNativeWorkspacePreflight =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'workspace_executable_customization' | 'workspace_sensitive_content';
      readonly path: string;
    };

/** Workspace hooks/MCP/agents execute or rewrite model/tool behavior before host policy can act. */
export function preflightAgyNativeWorkspace(workspaceRoot: string): AgyNativeWorkspacePreflight {
  const root = realpathSync(workspaceRoot);
  const entries = readdirSync(root);
  const safeEnvTemplates = new Set(['.env.example', '.env.local.example', '.env.example.opensource']);
  const sensitive = entries.find((entry) => {
    const name = entry.toLowerCase();
    return (
      ((name === '.env' || name.startsWith('.env.')) && !safeEnvTemplates.has(name)) ||
      ['.netrc', '.pypirc', '.ssh', '.aws'].includes(name)
    );
  });
  if (sensitive) return { ok: false, reason: 'workspace_sensitive_content', path: join(root, sensitive) };
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
