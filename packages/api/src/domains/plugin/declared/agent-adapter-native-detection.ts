import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveCliCommand } from '../../../utils/cli-resolve.js';
import { isCliPlainTextResult, spawnCli } from '../../../utils/cli-spawn.js';
import type { AgentAdapterRuntimeGrant } from './agent-adapter-access.js';

const officialDetection = [
  {
    pluginId: 'official.agent-kimi',
    contributionId: 'kimi',
    catalogId: 'agent-kimi',
    packageName: '@clowder-ai/agent-kimi',
    command: 'kimi',
  },
  {
    pluginId: 'official.agent-codex',
    contributionId: 'codex',
    catalogId: 'agent-codex',
    packageName: '@clowder-ai/agent-codex',
    command: 'codex',
  },
];

export const grantAgentAdapterDetection: AgentAdapterRuntimeGrant = (request) => {
  const source = request.packageProvenance;
  if (request.action !== 'detect' || source?.kind !== 'catalog') return;
  const grant = officialDetection.find(
    (entry) =>
      entry.pluginId === request.pluginId &&
      entry.contributionId === request.contributionId &&
      entry.catalogId === source.catalogId &&
      entry.packageName === source.packageName,
  );
  if (!grant) return;
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
