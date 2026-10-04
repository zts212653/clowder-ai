import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolExecutionPolicy } from '../../types.js';
import { normalizeToolExecutionPolicy } from '../invocation/tool-execution-policy.js';
import { CODEX_NATIVE_GUARD_HOOK_KEY, nativeEffectGuardHookHash } from './CodexNativeEffectGuard.js';

export type CollectiveWorkPolicy = Extract<ToolExecutionPolicy, { mode: 'collective_work' }>;

/** The admitted policy, never an ambient profile, selects the private server surface. */
export function buildCollectiveWorkMcpEnv(callbackEnv: Record<string, string>): Record<string, string> {
  return { ...callbackEnv, CAT_CAFE_MCP_PROFILE: 'collective-work' };
}

/** Task files persist; native config/credentials live beside them, outside the model's filesystem. */
export async function prepareCollectiveWorkDirectory(
  root: string,
  userId: string,
  threadId: string,
  taskId: string,
  executionRevision: number,
  executionRef: string,
) {
  const key = createHash('sha256')
    .update(JSON.stringify([userId, threadId, taskId]))
    .digest('hex');
  const executionKey = createHash('sha256')
    .update(JSON.stringify([executionRevision, executionRef]))
    .digest('hex');
  // Writable drafts belong to one native attempt; stale processes cannot overwrite a successor.
  const controlRoot = join(
    root,
    'collective-work',
    key,
    `execution-${executionRevision}-${executionKey}`,
    randomUUID(),
  );
  const workspaceRoot = join(controlRoot, 'workspace');
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  return { controlRoot: await realpath(controlRoot), workspaceRoot: await realpath(workspaceRoot) };
}

export function buildCollectiveWorkCodexPolicyArgs(input: CollectiveWorkPolicy): string[] {
  const policy = normalizeToolExecutionPolicy(input) as CollectiveWorkPolicy;
  const filesystem: Record<string, string> = { '/': 'deny', ':minimal': 'read', [policy.workspaceRoot]: 'write' };
  for (const root of policy.readOnlyRoots) filesystem[root] = 'read';
  return [
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--skip-git-repo-check',
    '--ephemeral',
    '--config',
    'project_doc_max_bytes=0',
    '--config',
    'skills.include_instructions=false',
    '--config',
    'orchestrator.skills.enabled=false',
    '--config',
    'orchestrator.mcp.enabled=false',
    '--config',
    'default_permissions="collective_work"',
    '--config',
    `permissions.collective_work.filesystem=${tomlMap(filesystem)}`,
    '--config',
    'permissions.collective_work.network.enabled=false',
    '--config',
    'approval_policy="never"',
    '--config',
    'shell_environment_policy.inherit="none"',
    '--config',
    `shell_environment_policy.set=${tomlMap({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', HOME: policy.workspaceRoot, TMPDIR: policy.workspaceRoot })}`,
    '--config',
    'shell_environment_policy.ignore_default_excludes=false',
    '--config',
    'web_search="disabled"',
    '--config',
    'apps._default.enabled=false',
    '--config',
    'mcp_servers={}',
    ...[
      'multi_agent',
      'apps',
      'plugins',
      'remote_plugin',
      'memories',
      'external_agent_memory_import',
      'skill_search',
      'skill_mcp_dependency_install',
      'browser_use',
      'browser_use_external',
      'computer_use',
      'image_generation',
      'in_app_browser',
      'in_app_local_automation',
      'goals',
      'tool_suggest',
      'shell_snapshot',
      'view_image',
    ].flatMap((feature) => ['--disable', feature]),
    '--enable',
    'code_mode_host',
    '--enable',
    'skip_host_skill_discovery',
  ];
}

/** Host hooks run before every native shell/edit effect. Credentials never enter shell_environment_policy. */
export async function buildCollectiveWorkAuthorityGuardArgs(controlRoot: string): Promise<string[]> {
  const script = join(controlRoot, 'authority-guard.mjs');
  await writeFile(
    script,
    [
      "const deny=()=>process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Current private Work authority unavailable'}})+'\\n');",
      'try {',
      'const base=process.env.CAT_CAFE_API_URL, id=process.env.CAT_CAFE_INVOCATION_ID, token=process.env.CAT_CAFE_CALLBACK_TOKEN;',
      "if(!base||!id||!token) throw Error('credentials unavailable');",
      "const response=await fetch(new URL('/api/callbacks/native-turn-admission',base),{headers:{'x-invocation-id':id,'x-callback-token':token},signal:AbortSignal.timeout(4000)});",
      'if(!response.ok) deny();',
      '} catch { deny(); }',
    ].join('\n'),
    { mode: 0o600 },
  );
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const hooks = `hooks={PreToolUse=[{matcher="Bash|Edit|Write",hooks=[{type="command",command=${JSON.stringify(command)},timeout=5,statusMessage="Checking protected effects…"}]}],state={${JSON.stringify(CODEX_NATIVE_GUARD_HOOK_KEY)}={enabled=true,trusted_hash=${JSON.stringify(nativeEffectGuardHookHash(command))}}}}`;
  return ['--config', 'features.hooks=true', '--config', hooks];
}

export function privateWorkControlRoot(policy: CollectiveWorkPolicy): string {
  return dirname(policy.workspaceRoot);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function tomlMap(value: Record<string, string>): string {
  return `{${Object.entries(value)
    .map(([key, entry]) => `${JSON.stringify(key)}=${JSON.stringify(entry)}`)
    .join(',')}}`;
}
