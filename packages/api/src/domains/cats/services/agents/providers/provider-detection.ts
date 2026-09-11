/**
 * Provider availability detection — the canonical answer to "which agent CLIs are installed
 * on this machine".
 *
 * Design rules inherited from this repo's history, not invented here:
 *
 *  - LL-055 (src extension): never boot an agent runtime just to ask it a question.
 *    `opencode version` starts a full agent process, ignores SIGTERM, and on macOS leaves an
 *    orphan at PPID=1 burning ~67% CPU. Detection therefore resolves binaries on PATH and
 *    stops there.
 *  - Version probing is opt-in (`CAT_PROVIDER_VERSION_PROBE=1`) and restricted to descriptors
 *    that declare `probe.strategy: 'path+version'`. A probe is bounded (hard timeout, then
 *    SIGKILL, plus a whole-tree kill on Windows) and a failure downgrades to "no version"
 *    rather than "not installed" — the same transient/confirmed distinction the CLI error
 *    classifier makes.
 *  - Detection never mutates anything. Callers decide what to do with the report.
 *
 * The ClientId → binary mapping lives in `@cat-cafe/shared`'s descriptor registry, so this
 * module contains no per-provider tables.
 */

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import {
  CLIENT_DESCRIPTORS,
  type ClientDescriptor,
  type ClientId,
  formatInstallHint,
  type ProviderAvailability,
  type ProviderAvailabilityReport,
} from '@cat-cafe/shared';
import { resolveCliCommand } from '../../../../../utils/cli-resolve.js';

export type { ProviderAvailability, ProviderAvailabilityReport, ProviderAvailabilityStatus } from '@cat-cafe/shared';

/** Injectables — tests substitute all three so no real PATH or subprocess is touched. */
export interface ProviderDetectionDeps {
  env?: NodeJS.ProcessEnv;
  /** Resolve a bare command name to an absolute path, or null when not found. */
  resolveCommand?: (command: string) => string | null;
  /** Whether an absolute path is an existing regular file. */
  isExecutableFile?: (path: string) => boolean;
  /** Read the CLI's own version. Only called when probing is enabled. */
  probeVersion?: (path: string, args: readonly string[]) => Promise<string | undefined>;
}

const VERSION_PROBE_TIMEOUT_MS = 2_000;

/** Env flag that turns version probing on. Absent/false keeps detection spawn-free. */
export const VERSION_PROBE_ENV = 'CAT_PROVIDER_VERSION_PROBE';

export function isVersionProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[VERSION_PROBE_ENV] === '1';
}

function defaultIsExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Bounded version query.
 *
 * Resolves to undefined — never throws — because an unreadable version must not be reported
 * as "not installed". A `.cmd`/`.bat` shim is skipped on Windows: `execFile` cannot run a
 * batch file without a shell, and detection will not start one.
 */
function defaultProbeVersion(path: string, args: readonly string[]): Promise<string | undefined> {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(path)) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const child = execFile(
      path,
      [...args],
      { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf-8' },
      (error, stdout) => {
        if (error) {
          finish(undefined);
          return;
        }
        const firstLine = String(stdout)
          .split('\n')
          .find((line) => line.trim().length > 0);
        finish(firstLine?.trim() || undefined);
      },
    );

    child.on('error', () => finish(undefined));
    if (child.pid === undefined) return;
    // Escalate past a child that ignores SIGTERM (the LL-055 failure mode) instead of waiting
    // on a process we cannot reap.
    const hardKill = setTimeout(() => {
      if (settled) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      finish(undefined);
    }, VERSION_PROBE_TIMEOUT_MS + 500);
    hardKill.unref();
    child.on('close', () => clearTimeout(hardKill));
  });
}

function reasonForMissing(descriptor: ClientDescriptor, installHint: string): string {
  const commands = descriptor.commands.join(' / ');
  const escapeHatch = descriptor.pathEnvVar ? `，或设置 ${descriptor.pathEnvVar} 指向二进制` : '';
  return `${descriptor.label} CLI (${commands}) 未在本机找到。已检查 PATH 与常见安装目录。请运行 \`${installHint}\` 安装后重试${escapeHatch}。`;
}

function reasonForBadOverride(descriptor: ClientDescriptor, path: string): string {
  return `${descriptor.pathEnvVar} 指向的路径不存在或不是文件：${path}。请修正该环境变量，或删除它以回退到 PATH 探测。`;
}

async function probeOne(
  descriptor: ClientDescriptor,
  deps: Required<Pick<ProviderDetectionDeps, 'env' | 'resolveCommand' | 'isExecutableFile' | 'probeVersion'>>,
  versionProbeEnabled: boolean,
): Promise<ProviderAvailability> {
  const installHint = formatInstallHint(descriptor);
  const apiKeyEnv = descriptor.probe.apiKeyEnv;
  const hasApiKey = apiKeyEnv ? Boolean(deps.env[apiKeyEnv]) : false;
  const base = {
    clientId: descriptor.clientId,
    toolId: descriptor.toolId,
    label: descriptor.label,
    command: descriptor.commands[0] ?? descriptor.defaultCli.command,
    hasApiKey,
    installHint,
    localCli: descriptor.localCli,
  } as const;

  if (!descriptor.localCli) {
    return {
      ...base,
      installed: false,
      resolvedVia: 'unavailable',
      status: 'unsupported',
      reason: `${descriptor.label} 不使用本机 CLI（由 bridge / 远程端点提供），无需安装。`,
    };
  }

  // 1. Explicit override wins, and a broken override is a hard error rather than a silent
  //    fall-through to a different binary than the operator asked for.
  const override = descriptor.pathEnvVar ? deps.env[descriptor.pathEnvVar]?.trim() : undefined;
  if (override) {
    if (!deps.isExecutableFile(override)) {
      return {
        ...base,
        installed: false,
        resolvedVia: 'unavailable',
        status: 'error',
        reason: reasonForBadOverride(descriptor, override),
      };
    }
    const version = versionProbeEnabled ? await probeVersionFor(descriptor, override, deps) : undefined;
    return {
      ...base,
      installed: true,
      command: override,
      resolvedPath: override,
      resolvedVia: 'env-override',
      ...(version ? { version } : {}),
      status: 'configured',
    };
  }

  // 2. Candidate commands, highest priority first.
  for (const command of descriptor.commands) {
    const resolved = deps.resolveCommand(command);
    if (!resolved) continue;
    const version = versionProbeEnabled ? await probeVersionFor(descriptor, resolved, deps) : undefined;
    return {
      ...base,
      installed: true,
      command,
      resolvedPath: resolved,
      resolvedVia: 'path',
      ...(version ? { version } : {}),
      status: 'configured',
    };
  }

  // 3. Nothing resolved.
  return {
    ...base,
    installed: false,
    resolvedVia: 'unavailable',
    status: 'missing',
    reason: reasonForMissing(descriptor, installHint),
  };
}

async function probeVersionFor(
  descriptor: ClientDescriptor,
  path: string,
  deps: { probeVersion: (path: string, args: readonly string[]) => Promise<string | undefined> },
): Promise<string | undefined> {
  if (descriptor.probe.strategy !== 'path+version' || !descriptor.probe.versionArgs) return undefined;
  return deps.probeVersion(path, descriptor.probe.versionArgs);
}

/**
 * Probe every client in the descriptor registry, in parallel.
 *
 * Never rejects: a throwing dependency on one provider downgrades that provider to `missing`
 * so one bad probe cannot blank the whole report.
 */
export async function detectProviderAvailability(
  deps: ProviderDetectionDeps = {},
): Promise<ProviderAvailabilityReport> {
  const env = deps.env ?? process.env;
  const resolved: Required<
    Pick<ProviderDetectionDeps, 'env' | 'resolveCommand' | 'isExecutableFile' | 'probeVersion'>
  > = {
    env,
    resolveCommand: deps.resolveCommand ?? resolveCliCommand,
    isExecutableFile: deps.isExecutableFile ?? defaultIsExecutableFile,
    probeVersion: deps.probeVersion ?? defaultProbeVersion,
  };
  const versionProbeEnabled = isVersionProbeEnabled(env);

  const providers = await Promise.all(
    CLIENT_DESCRIPTORS.map(async (descriptor) => {
      try {
        return await probeOne(descriptor, resolved, versionProbeEnabled);
      } catch (error) {
        const installHint = formatInstallHint(descriptor, process.platform);
        return {
          clientId: descriptor.clientId,
          toolId: descriptor.toolId,
          label: descriptor.label,
          installed: false,
          command: descriptor.commands[0] ?? descriptor.defaultCli.command,
          resolvedVia: 'unavailable',
          hasApiKey: false,
          installHint,
          localCli: descriptor.localCli,
          status: 'missing',
          reason: `${descriptor.label} 探测失败：${error instanceof Error ? error.message : String(error)}。请检查 ${descriptor.pathEnvVar ?? 'PATH'} 后重试。`,
        } satisfies ProviderAvailability;
      }
    }),
  );

  return {
    detectedAt: new Date().toISOString(),
    versionProbeEnabled,
    providers,
  };
}

/** Providers that are installed and backed by a local CLI. */
export function installedProviders(report: ProviderAvailabilityReport): ProviderAvailability[] {
  return report.providers.filter((provider) => provider.installed && provider.localCli);
}

/** Availability lookup keyed by clientId, for callers annotating member lists. */
export function availabilityByClientId(
  report: ProviderAvailabilityReport,
): ReadonlyMap<ClientId, ProviderAvailability> {
  return new Map(report.providers.map((provider) => [provider.clientId, provider]));
}
