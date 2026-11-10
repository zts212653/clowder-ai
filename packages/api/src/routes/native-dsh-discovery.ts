import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { findDshDesktopCommands } from '../utils/dsh-desktop-launch.js';

interface DiscoveryOptions {
  desktopRoots?: string[];
}

/** Automatic onboarding supports Desktop only. Its Host ACP home is prepared explicitly later. */
export async function discoverDshRuntimes(options: DiscoveryOptions = {}) {
  const commands = await findDshDesktopCommands(options.desktopRoots);
  return (commands.length ? commands : [undefined]).map((command) => ({
    id:
      commands.length > 1 && command
        ? `dsh:${createHash('sha256').update(command.toLowerCase()).digest('hex').slice(0, 16)}`
        : 'dsh',
    label: commands.length > 1 && command ? `DSH Desktop · ${resolve(dirname(command), '../../../..')}` : 'DSH Desktop',
    clientId: 'acp' as const,
    installed: Boolean(command),
    command,
    dshDesktop: true,
    ...(command
      ? { dshSetupSupported: true, acp: { command, startupArgs: ['--profile', 'acp'], transport: 'stdio' as const } }
      : {}),
    models: [] as string[],
    defaultsStatus: 'session_only',
    transport: 'acp',
    ...(!command ? { discoveryStatus: 'not_installed' as const } : {}),
  }));
}
