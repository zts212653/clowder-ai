import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { getAcpConfig, loadResolvedCatConfig, toAllCatConfigs } from '../config/cat-config-loader.js';
import { AcpClient } from '../domains/cats/services/agents/providers/acp/AcpClient.js';
import { resolveAcpBootstrapCommand } from '../domains/cats/services/agents/providers/acp/acp-bootstrap-cwd.js';
import { denyAgyAcpPermission } from '../domains/cats/services/agents/providers/acp/agy/agy-acp-permission.js';
import { prepareAgyAcpProfile } from '../domains/cats/services/agents/providers/acp/agy/agy-acp-profile.js';
import { findMonorepoRoot } from '../utils/monorepo-root.js';

/** Run by the operator after selecting and saving this member's official ACP path. */
export async function loginAgyAcp(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { cat: { type: 'string' }, help: { type: 'boolean' } },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      'Usage: pnpm agy:acp:login --cat <member-id>\nUses the saved official ACP command/Profile. Opens personal OAuth only; no model call.\n',
    );
    return;
  }
  if (!values.cat || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values.cat))
    throw new Error('Supply the saved member ID with --cat');
  const projectRoot = findMonorepoRoot();
  const config = toAllCatConfigs(loadResolvedCatConfig(join(projectRoot, 'cat-config.json')))[values.cat];
  const acp = getAcpConfig(values.cat, projectRoot);
  if (
    config?.clientId !== 'google' ||
    config.carrier !== 'acp' ||
    config.agyProfile?.carrier !== 'acp' ||
    !acp ||
    acp.transport === 'httpstream'
  )
    throw new Error('Save the member with AGY official ACP and its isolated Profile before logging in');
  const prepared = await prepareAgyAcpProfile({
    catId: values.cat,
    model: config.defaultModel,
    projectRoot,
    profile: config.agyProfile,
  });
  const client = new AcpClient({
    command: resolveAcpBootstrapCommand(projectRoot, acp.command),
    args: acp.startupArgs,
    cwd: prepared.antigravity.profileHome,
    env: prepared.env,
    inheritParentEnv: false,
    permissionHandler: denyAgyAcpPermission,
  });
  try {
    const init = await client.initialize();
    if (!init.authMethods.some((method) => method.id === 'oauth-personal'))
      throw new Error('This ACP server does not advertise personal OAuth');
    process.stdout.write(
      `Complete personal OAuth in the browser for ${values.cat}. No Chat or model turn will start.\n`,
    );
    await client.authenticate('oauth-personal');
    process.stdout.write('ACP authentication completed. You can now start a new Chat session for this member.\n');
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loginAgyAcp(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'ACP login failed'}\n`);
    process.exitCode = 1;
  });
}
