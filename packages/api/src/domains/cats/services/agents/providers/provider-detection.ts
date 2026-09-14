/**
 * Provider availability detection — the canonical answer to "which agent CLIs are installed
 * on this machine".
 *
 * Design rules inherited from this repo's history, not invented here:
 *
 *  - **LL-055 is upheld literally.** Low-cost detection / health-probe paths must not spawn a
 *    complex runtime: `opencode version` boots a full agent process, ignores SIGTERM, and on
 *    macOS (no `PR_SET_PDEATHSIG`) leaves an orphan at PPID=1 burning ~67% CPU. Detection
 *    therefore resolves the binary and stops — it starts no process of any kind, for any
 *    provider. There is no version field on the descriptor and no opt-in flag, because an
 *    opt-in version probe would still be the thing LL-055 forbids; reintroducing one is a
 *    policy decision that belongs in an accepted issue.
 *  - Detection never mutates anything. Callers decide what to do with the report.
 *  - A failure to *learn something* is never reported as "not installed". Only a clean
 *    resolution miss produces `missing`; an unusable `CAT_<CLIENT>_PATH` override produces
 *    `error`, because those need different repairs.
 *
 * The ClientId → binary mapping lives in `@cat-cafe/shared`'s descriptor registry, so this
 * module contains no per-provider tables.
 */

import {
  CLIENT_DESCRIPTORS,
  type ClientDescriptor,
  formatInstallHint,
  type ProviderAvailability,
  type ProviderAvailabilityReport,
} from '@cat-cafe/shared';
import { isExecutableFileAt, resolveCliCommand } from '../../../../../utils/cli-resolve.js';

export type { ProviderAvailability, ProviderAvailabilityReport, ProviderAvailabilityStatus } from '@cat-cafe/shared';

/**
 * Injectables — tests substitute both so no real PATH is touched.
 *
 * Note there is no version-probe seam: the absence of the seam is the guarantee. A test can
 * therefore assert spawn-freedom structurally rather than by observing a mock that was never
 * called.
 */
export interface ProviderDetectionDeps {
  env?: NodeJS.ProcessEnv;
  /** Resolve a bare command name to an absolute path, or null when not found. */
  resolveCommand?: (command: string) => string | null;
  /** Whether an absolute path is an existing regular file. Defaults to the resolver's own test. */
  isExecutableFile?: (path: string) => boolean;
}

function reasonForMissing(descriptor: ClientDescriptor, installHint: string): string {
  const commands = descriptor.commands.join(' / ');
  // The pin answers for the client's canonical command only (cli-resolve.ts `pinnedPathFor`), so
  // name that command rather than promising a generic "point it at the binary": google's
  // candidates are `agy` / `gemini`, but `CAT_GOOGLE_PATH` cannot make a failing `gemini`
  // resolve. A generic sentence here would reproduce the probe-green/launch-fail guarantee.
  const escapeHatch = descriptor.pathEnvVar
    ? `，或设置 ${descriptor.pathEnvVar} 指向 ${descriptor.defaultCli.command} 二进制`
    : '';
  return `${descriptor.label} CLI (${commands}) 未在本机找到。已检查 PATH 与常见安装目录。请运行 \`${installHint}\` 安装后重试${escapeHatch}。`;
}

function reasonForBadOverride(descriptor: ClientDescriptor, path: string): string {
  return `${descriptor.pathEnvVar} 指向的路径不存在或不是文件：${path}。请修正该环境变量，或删除它以回退到 PATH 探测。`;
}

function probeOne(
  descriptor: ClientDescriptor,
  deps: Required<Pick<ProviderDetectionDeps, 'env' | 'resolveCommand' | 'isExecutableFile'>>,
): ProviderAvailability {
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
    return {
      ...base,
      installed: true,
      command: override,
      resolvedPath: override,
      resolvedVia: 'env-override',
      status: 'configured',
    };
  }

  // 2. Candidate commands, highest priority first. Resolution only — nothing is executed.
  for (const command of descriptor.commands) {
    const resolved = deps.resolveCommand(command);
    if (!resolved) continue;
    return {
      ...base,
      installed: true,
      command,
      resolvedPath: resolved,
      resolvedVia: 'path',
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

/**
 * Probe every client in the descriptor registry, in parallel.
 *
 * Never rejects: a throwing dependency on one provider downgrades that provider to `missing`
 * so one bad probe cannot blank the whole report.
 */
export async function detectProviderAvailability(
  deps: ProviderDetectionDeps = {},
): Promise<ProviderAvailabilityReport> {
  const resolved: Required<Pick<ProviderDetectionDeps, 'env' | 'resolveCommand' | 'isExecutableFile'>> = {
    env: deps.env ?? process.env,
    resolveCommand: deps.resolveCommand ?? resolveCliCommand,
    isExecutableFile: deps.isExecutableFile ?? isExecutableFileAt,
  };

  const providers = CLIENT_DESCRIPTORS.map((descriptor) => {
    try {
      return probeOne(descriptor, resolved);
    } catch (error) {
      return {
        clientId: descriptor.clientId,
        toolId: descriptor.toolId,
        label: descriptor.label,
        installed: false,
        command: descriptor.commands[0] ?? descriptor.defaultCli.command,
        resolvedVia: 'unavailable',
        hasApiKey: false,
        installHint: formatInstallHint(descriptor),
        localCli: descriptor.localCli,
        status: 'missing',
        reason: `${descriptor.label} 探测失败：${error instanceof Error ? error.message : String(error)}。请检查 ${descriptor.pathEnvVar ?? 'PATH'} 后重试。`,
      } satisfies ProviderAvailability;
    }
  });

  return {
    detectedAt: new Date().toISOString(),
    providers,
  };
}
