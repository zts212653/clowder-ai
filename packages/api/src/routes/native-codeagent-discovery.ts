import { resolveCliCommand } from '../utils/cli-resolve.js';

const INTRANET_ROLES = ['maine-coon'] as const;

/** Built into the Host: PATH/file discovery only, no plugin, credentials, prompt or agent process. */
export function discoverCodeAgentRuntimes(
  commandFor: typeof resolveCliCommand = resolveCliCommand,
  intranet = process.env.CAT_CAFE_INTRANET_EDITION === '1',
) {
  const command = commandFor('codeagent');
  return [
    {
      id: 'codeagent',
      label: 'CodeAgent',
      kind: 'tool' as const,
      harnessId: 'codeagent' as const,
      clientId: 'acp' as const,
      roleTemplates: (intranet ? INTRANET_ROLES : ['ragdoll']).map((id) => ({ id, priority: intranet ? 100 : 0 })),
      installed: Boolean(command),
      command: command ?? undefined,
      ...(command ? { acp: { command, startupArgs: ['--acp'], transport: 'stdio' as const } } : {}),
      discoveryStatus: command ? ('configured' as const) : ('not_installed' as const),
      models: [] as string[],
      defaultsStatus: 'session_only' as const,
      transport: 'acp',
    },
  ];
}
