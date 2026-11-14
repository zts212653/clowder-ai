import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginMcpEnvironment } from '../../../../../../../config/capabilities/plugin-mcp-environment.js';
import type { DshNativeAccount } from '../../../../../../../config/native-accounts/dsh-account.js';
import type { DshNativeLaunch } from '../../../../../../../config/native-accounts/dsh-installation.js';
import type { AgentServiceOptions } from '../../../../types.js';
import { prepareDshSecretPatch } from '../../dsh-secret-patch.js';
import { DSH_MEMBER_PLUGIN } from './dsh-member-plugin.js';

/** Native ACP uses this same normalization before qualifying MCP tool names. */
export function dshMemberServerName(name: string): string {
  if (!name.trim() || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('dsh_member_server_invalid');
  if (/^[A-Za-z0-9_-]{1,32}$/.test(name)) return name;
  return `${
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'server'
  }_${createHash('sha256').update(name).digest('hex').slice(0, 8)}`.slice(0, 32);
}

/** Private per-turn configuration reads the original native credential store.
 * It copies no key, login, profile, session or native default. */
export async function prepareDshMemberLaunch(input: {
  readonly native: DshNativeLaunch;
  readonly account: DshNativeAccount;
  readonly identity: string;
  readonly member: NonNullable<AgentServiceOptions['pluginNativeLaunch']>;
  readonly callbackEnv: Readonly<Record<string, string>>;
}) {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-dsh-member-'));
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    const home = join(root, 'native'),
      workspace = join(root, 'workspace'),
      plugin = join(root, 'member.mjs'),
      patch = join(root, 'member.patch.json');
    await Promise.all([mkdir(home), mkdir(workspace)]);
    await writeFile(plugin, DSH_MEMBER_PLUGIN, { mode: 0o600, flag: 'wx' });
    const require = createRequire(input.native.packagePath);
    const serverName = dshMemberServerName(input.member.server.name);
    const disabled = [
      'agent-instructions',
      'skill',
      'skill-filesystem',
      'tool-skill',
      'mcp-resources',
      'plugin-manager',
      'config-editor',
      'settings',
    ];
    await writeFile(
      patch,
      JSON.stringify([
        ...disabled.map((id) => ({ id, disabled: true })),
        { id: 'credentials', config: { path: input.account.credentialPath, watch: false } },
        { id: 'llm-deepseek', config: input.account.providerConfig },
        { id: 'tools', config: { mode: 'native' } },
        {
          insert: [
            {
              id: 'cat-cafe-member',
              name: pathToFileURL(plugin).href,
              config: {
                credentialRef: input.account.credentialRef,
                keyDigest: input.account.keyDigest,
                identity: input.identity,
                mcpModule: pathToFileURL(require.resolve('@deepseek-ai/dsh-mcp-client')).href,
                toolPrefix: `mcp__${serverName}__`,
                serverName,
                server: {
                  ...input.member.server,
                  env: pluginMcpEnvironment(
                    { source: 'plugin', env: { ...input.member.server.env } },
                    input.callbackEnv,
                  ),
                },
              },
            },
          ],
        },
        {
          id: 'acp',
          inject: ['acpAppStartup', 'catCafeSecretContent', 'catCafeScopedMember'],
          config: { provider: input.account.provider, model: input.account.model },
        },
      ]),
      { mode: 0o600, flag: 'wx' },
    );
    // The Native contract was already verified, including node+official-entry
    // launches; this existing factory writes the reviewed DSH privacy guard.
    const secretArgs = await prepareDshSecretPatch('dsh', [...input.native.args], root);
    const env: Record<string, string> = {
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(root, 'agents'),
      HOME: join(root, 'home'),
      DSH_TELEMETRY_DISABLED: '1',
    };
    for (const key of [
      'PATH',
      'LANG',
      'LC_ALL',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'NODE_EXTRA_CA_CERTS',
    ]) {
      const value = input.native.env[key] ?? process.env[key];
      if (value) env[key] = value;
    }
    return { command: input.native.command, args: [...secretArgs, '--patch', patch], cwd: workspace, env, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
