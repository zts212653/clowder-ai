import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveKimiQuotaExecutionOwner } from '../../../config/kimi-quota-identity.js';
import { captureTerminalInteraction } from '../../../utils/capture-terminal-interaction.js';
import { resolveCliCommand } from '../../../utils/cli-resolve.js';
import { isCliPlainTextResult, spawnCli } from '../../../utils/cli-spawn.js';
import type { AgentAdapterRuntimeGrant } from './agent-adapter-access.js';

const officialNativeClients = [
  {
    pluginId: 'official.agent-kimi',
    contributionId: 'kimi',
    catalogId: 'agent-kimi',
    packageName: '@clowder-ai/agent-kimi',
    command: 'kimi',
    terminalCommand: '/usage',
  },
  {
    pluginId: 'official.agent-codex',
    contributionId: 'codex',
    catalogId: 'agent-codex',
    packageName: '@clowder-ai/agent-codex',
    command: 'codex',
  },
  {
    pluginId: 'official.agent-claude-code',
    contributionId: 'claude-code',
    catalogId: 'agent-claude-code',
    packageName: '@clowder-ai/agent-claude-code',
    command: 'claude',
  },
  {
    pluginId: 'official.agent-agy',
    contributionId: 'agy',
    catalogId: 'agent-agy',
    packageName: '@clowder-ai/agent-agy',
    command: 'agy',
  },
];

export const grantAgentAdapterNativeRuntime: AgentAdapterRuntimeGrant = (request) => {
  const source = request.packageProvenance;
  if (source?.kind !== 'catalog') return;
  const grant = officialNativeClients.find(
    (entry) =>
      entry.pluginId === request.pluginId &&
      entry.contributionId === request.contributionId &&
      entry.catalogId === source.catalogId &&
      entry.packageName === source.packageName,
  );
  if (!grant) return;

  if (request.action === 'quota' && request.account && grant.terminalCommand) {
    const { account } = request;
    const terminalCommand = grant.terminalCommand;
    const readOwner = () => {
      const owner = resolveKimiQuotaExecutionOwner(account.projectRoot, account.accountRef);
      if (
        !owner ||
        owner.snapshot.credentialVersion !== account.credentialVersion ||
        owner.snapshot.accountRevision !== account.accountRevision
      ) {
        throw new Error('kimi_quota_credential_changed');
      }
      return owner;
    };
    return {
      terminal: {
        async capture({ submit }, signal) {
          if (submit !== terminalCommand) throw new Error('Terminal input is not authorized');
          signal.throwIfAborted();
          const { launchEnv } = readOwner();
          const command = resolveCliCommand(grant.command);
          if (!command) throw new Error('Native terminal command is unavailable');
          const result = await captureTerminalInteraction({
            command,
            args: [],
            cwd: account.projectRoot,
            env: {
              ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
              ...launchEnv,
            },
            submit: terminalCommand,
            startAfterMs: 4_500,
            settleAfterMs: 2_500,
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          });
          readOwner();
          return result;
        },
      },
    };
  }
  if (request.action !== 'detect') return;

  return {
    async inspect(signal) {
      signal.throwIfAborted();
      const command = resolveCliCommand(grant.command);
      if (!command) return { status: 'not-installed' };
      // Version probes are independent of project and provider accounts.
      const tempRoot = resolve(tmpdir());
      const home = await mkdtemp(join(tempRoot, 'agent-version-probe-'));
      try {
        const env = {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? null,
          ComSpec: process.env.ComSpec ?? null,
          PATHEXT: process.env.PATHEXT ?? null,
          HOME: home,
          USERPROFILE: home,
          APPDATA: home,
          LOCALAPPDATA: home,
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: home,
          XDG_CACHE_HOME: home,
          TEMP: home,
          TMP: home,
          TMPDIR: home,
        };
        for await (const result of spawnCli({
          command,
          args: ['--version'],
          cwd: home,
          env,
          signal,
          timeoutMs: 3_500,
          bindExecutionOwner: false,
          inheritParentEnv: false,
          outputMode: 'plainText',
          assertLaunchCurrent: () => signal.throwIfAborted(),
        })) {
          if (!isCliPlainTextResult(result) || result.exitCode !== 0) continue;
          const version = /\b\d+\.\d+\.\d+(?:[-+][\w.+-]+)?\b/.exec(result.stdout || result.stderr)?.[0];
          if (version) return { status: 'ready', version };
        }
      } catch {
        signal.throwIfAborted();
      } finally {
        if (dirname(home) === tempRoot) await rm(home, { recursive: true, force: true, maxRetries: 2 });
      }
      return { status: 'unavailable', reason: 'native_version_probe_failed' };
    },
  };
};
