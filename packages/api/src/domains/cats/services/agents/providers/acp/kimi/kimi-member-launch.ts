import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginMcpEnvironment } from '../../../../../../../config/capabilities/plugin-mcp-environment.js';
import type { KimiNativeAccount } from '../../../../../../../config/native-accounts/kimi-account.js';
import type { KimiNativeLaunch } from '../../../../../../../config/native-accounts/kimi-installation.js';
import type { AgentServiceOptions } from '../../../../types.js';

const TEMPLATE_VARIABLE =
  /\$\{(?:base_prompt|agents_md|cwd|cwd_listing|skills|skills_section|plugin_sections|additional_dirs_info|additional_dirs_section|os|shell|windows_notes|reply_style_guide|product_name|role_additional|notify_user_guidance|todo_list_guidance)\}/;

/** Use the installed public workspace-agent/MCP formats. Credentials remain in the original native home. */
export async function prepareKimiMemberLaunch(input: {
  readonly native: KimiNativeLaunch;
  readonly account: KimiNativeAccount;
  readonly identity: string;
  readonly member: NonNullable<AgentServiceOptions['pluginNativeLaunch']>;
  readonly callbackEnv: Readonly<Record<string, string>>;
}) {
  if (TEMPLATE_VARIABLE.test(input.identity)) throw new Error('kimi_member_identity_template_unsafe');
  if (input.member.server.transport !== 'stdio') throw new Error('kimi_member_stdio_required');
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-kimi-member-'));
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    const workspace = join(root, 'workspace'),
      config = join(workspace, '.kimi-code');
    await mkdir(join(config, 'agents'), { recursive: true });
    // A short per-turn namespace cannot collide with inherited MCP names or be truncated away by Native.
    const serverName = `member_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const profile = `---\nname: agent\ndescription: Host-scoped member\noverride: true\ntools: ["mcp__${serverName}__*"]\ndisallowedTools: ["select_tools"]\nsubagents: []\n---\n${input.identity}\n`;
    await writeFile(join(config, 'agents/agent.md'), profile, { mode: 0o600, flag: 'wx' });
    const disabled = Object.fromEntries(
      input.account.foreignServers.map((name) => [
        name,
        {
          command: process.execPath,
          args: ['-e', 'process.exit(1)'],
          enabled: false,
        },
      ]),
    );
    const server = input.member.server;
    await writeFile(
      join(config, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          ...disabled,
          [serverName]: {
            transport: 'stdio',
            command: server.command,
            args: server.args,
            env: pluginMcpEnvironment({ source: 'plugin', env: { ...server.env } }, input.callbackEnv),
            cwd: server.workingDirectory,
            runtime_id: 'local',
            deferred: false,
          },
        },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    return {
      command: input.native.command,
      args: [...input.native.args],
      cwd: workspace,
      // Public process-local trust applies only to this owned ACP process and its single private workspace.
      // Native's persistent workspace trust store and outside sessions are not changed.
      env: { ...input.account.env, KIMI_CODE_TRUST_WORKSPACE: '1' },
      serverName,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
