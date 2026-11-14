import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionAccountSnapshot } from '@cat-cafe/shared';
import { stringify } from 'yaml';
import { pluginMcpEnvironment } from '../../../../../config/capabilities/plugin-mcp-environment.js';
import type { AgentServiceOptions } from '../../types.js';
import { captureScopedMemberLaunch } from '../invocation/scoped-member-launch.js';
import { normalizeToolExecutionPolicy } from '../invocation/tool-execution-policy.js';

/** API environment isolation is verified. Native OAuth refresh ownership has
 * not yet been proven for a private Kimi home; never copy/link its login files. */
export function assertKimiMemberAccount(account: ExecutionAccountSnapshot | undefined): void {
  if (!account) throw new Error('kimi_scoped_account_required');
  if (account.authType !== 'api_key') throw new Error('kimi_scoped_oauth_unavailable');
}

/** Capture all mutable authority/account inputs before the first await. */
export function captureKimiMemberOptions(input?: AgentServiceOptions): AgentServiceOptions | undefined {
  if (!input?.pluginNativeLaunch) {
    if (input?.toolExecutionPolicy?.mode === 'plugin_native') throw new Error('kimi_native_launch_required');
    return undefined;
  }
  if (!input.toolExecutionPolicy) throw new Error('kimi_scoped_member_policy_required');
  if (input.spawnCliOverride || input.agentCarrierSessionFactory || input.requiredTools?.length || !input.signal)
    throw new Error('kimi_scoped_native_launch_unavailable');
  const launch = captureScopedMemberLaunch(
    {
      scopedMemberLaunch: input.pluginNativeLaunch,
      toolExecutionPolicy: input.toolExecutionPolicy,
      systemPrompt: input.systemPrompt,
      contentBlocks: input.contentBlocks,
      liveCompanion: input.liveCompanion,
    },
    input.workingDirectory,
  );
  if (!launch || !/^[A-Za-z0-9_.-]+$/.test(launch.server.name)) throw new Error('kimi_native_server_invalid');
  assertKimiMemberAccount(input.executionAccount);
  return {
    ...input,
    pluginNativeLaunch: launch,
    toolExecutionPolicy: normalizeToolExecutionPolicy(input.toolExecutionPolicy),
    workingDirectory: launch.sandbox.workspaceRoot,
    accountEnv: Object.freeze({ ...input.accountEnv }),
    callbackEnv: Object.freeze({ ...input.callbackEnv }),
    executionAccount: Object.freeze(structuredClone(input.executionAccount)),
    sessionId: undefined,
    cliSessionId: undefined,
    cliConfigArgs: undefined,
    resumeFallbackSystemPrompt: undefined,
  };
}

/** Host-owned, short-lived CLI configuration. The model gets no file/shell tool,
 * no base prompt/workspace imports, no home skills, and no subagent surface. */
export async function prepareKimiMemberProfile(input: {
  readonly options: AgentServiceOptions;
  readonly catId: string;
  readonly l0: string;
  readonly parentDirectory?: string;
}) {
  const launch = input.options.pluginNativeLaunch;
  if (!launch) throw new Error('kimi_native_launch_required');
  await launch.assertCurrent();
  const directory = await mkdtemp(join(input.parentDirectory ?? tmpdir(), 'kimi-host-member-'));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const home = join(directory, 'home'),
      skills = join(directory, 'empty-skills'),
      agentFile = join(directory, 'agent.md');
    await mkdir(home, { mode: 0o700 });
    await mkdir(skills, { mode: 0o700 });
    const frontmatter = stringify(
      {
        name: `member-${input.catId}`,
        description: 'Host-approved member identity and tools',
        tools: [`mcp__${launch.server.name}__*`],
        subagents: [],
      },
      { lineWidth: 0 },
    ).trimEnd();
    await writeFile(agentFile, `---\n${frontmatter}\n---\n\n${input.l0}\n`, { mode: 0o600 });
    const server = launch.server;
    await writeFile(
      join(home, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          [server.name]: {
            command: server.command,
            args: server.args,
            cwd: server.workingDirectory,
            env: pluginMcpEnvironment({ source: 'plugin', env: { ...server.env } }, input.options.callbackEnv ?? {}),
          },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(home, 'config.toml'),
      'auto_session_title = false\nmerge_all_available_skills = false\nbuiltin_product_skills = false\ntelemetry = false\n',
      { mode: 0o600 },
    );
    await writeFile(join(home, 'tui.toml'), '[upgrade]\nauto_install = false\n', { mode: 0o600 });
    await launch.assertCurrent();
    return {
      agentFile,
      skillsDirectory: skills,
      env: {
        KIMI_CODE_HOME: home,
        KIMI_CODE_TRUST_WORKSPACE: '1',
        KIMI_CODE_BUILTIN_PRODUCT_SKILLS: '0',
        KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: '0',
        KIMI_DISABLE_TELEMETRY: '1',
        KIMI_CODE_EXPERIMENTAL_FLAG: '1',
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
