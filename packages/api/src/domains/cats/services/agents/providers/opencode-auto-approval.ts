import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { isCliError, isCliPlainTextResult, isCliTimeout, spawnCli } from '../../../../../utils/cli-spawn.js';

const log = createModuleLogger('opencode-agent');

export const OPENCODE_AUTO_APPROVE_FLAG = '--auto';
const OPENCODE_DEFAULT_AUTO_APPROVE_FLAGS = [
  OPENCODE_AUTO_APPROVE_FLAG,
  '--dangerously-skip-permissions',
  '--yolo',
] as const;
const OPENCODE_AUTO_APPROVE_FLAG_ALIASES = new Set([
  ...OPENCODE_DEFAULT_AUTO_APPROVE_FLAGS,
  '--no-auto',
  '--no-yolo',
  '--no-dangerously-skip-permissions',
]);
const OPENCODE_AUTO_APPROVE_PROBE_TIMEOUT_MS = 10_000;
const OPENCODE_AUTO_APPROVE_UNAVAILABLE_MESSAGE =
  'OpenCode run --help did not advertise a supported auto-approval flag; continuing without default approval flag injection.';
const OPENCODE_AUTO_APPROVE_PROBE_FAILED_MESSAGE =
  'Unable to confirm OpenCode auto-approval flag support; continuing without default approval flag injection.';

export type OpenCodeAutoApproveProbeResult = { approvalFlag?: string; warning?: string; cacheable?: boolean };
export type OpenCodeAutoApproveProbeFn = (options: {
  command: string;
  cwd?: string;
  env?: Record<string, string | null>;
}) => Promise<OpenCodeAutoApproveProbeResult>;
type OpenCodeHelpProbeResult =
  | { status: 'ok'; helpText: string }
  | { status: 'unsupported' }
  | { status: 'transient-failure' };

export function getCliFlagName(part: string): string | null {
  if (!part.startsWith('-')) return null;
  const equalsIndex = part.indexOf('=');
  return equalsIndex > 0 ? part.slice(0, equalsIndex) : part;
}

export function parseOpenCodeCliConfigArgs(cliConfigArgs?: readonly string[]): string[] {
  const userParts: string[] = [];
  for (const arg of cliConfigArgs ?? []) {
    userParts.push(...arg.trim().split(/\s+/));
  }
  return userParts;
}

export function userControlsOpenCodeAutoApprove(userFlags: ReadonlySet<string>): boolean {
  return Array.from(OPENCODE_AUTO_APPROVE_FLAG_ALIASES).some((flag) => userFlags.has(flag));
}

async function probeOpenCodeHelp(
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: Record<string, string | null>,
  options?: { cliErrorAsUnsupported?: boolean },
): Promise<OpenCodeHelpProbeResult> {
  let helpText = '';
  try {
    for await (const event of spawnCli({
      command,
      args,
      outputMode: 'plainText',
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
      timeoutMs: OPENCODE_AUTO_APPROVE_PROBE_TIMEOUT_MS,
    })) {
      if (isCliPlainTextResult(event)) {
        helpText = `${event.stdout}\n${event.stderr}`;
        continue;
      }
      if (isCliTimeout(event)) {
        log.warn({ command, timeoutMs: OPENCODE_AUTO_APPROVE_PROBE_TIMEOUT_MS }, 'OpenCode help probe timed out');
        return { status: 'transient-failure' };
      }
      if (isCliError(event)) {
        log.warn({ command, exitCode: event.exitCode, signal: event.signal }, 'OpenCode help probe failed');
        return options?.cliErrorAsUnsupported ? { status: 'unsupported' } : { status: 'transient-failure' };
      }
    }
  } catch (err) {
    log.warn({ command, err }, 'OpenCode help probe threw');
    return { status: 'transient-failure' };
  }

  return { status: 'ok', helpText };
}

export async function probeOpenCodeAutoApproveSupport(
  command: string,
  cwd?: string,
  env?: Record<string, string | null>,
): Promise<OpenCodeAutoApproveProbeResult> {
  const visibleHelp = await probeOpenCodeHelp(command, ['run', '--help'], cwd, env);
  if (visibleHelp.status !== 'ok') {
    return { warning: OPENCODE_AUTO_APPROVE_PROBE_FAILED_MESSAGE, cacheable: false };
  }

  for (const flag of OPENCODE_DEFAULT_AUTO_APPROVE_FLAGS) {
    if (visibleHelp.helpText.includes(flag)) return { approvalFlag: flag };
  }

  for (const flag of OPENCODE_DEFAULT_AUTO_APPROVE_FLAGS.slice(1)) {
    const hiddenHelp = await probeOpenCodeHelp(command, ['run', flag, '--help'], cwd, env, {
      cliErrorAsUnsupported: true,
    });
    if (hiddenHelp.status === 'ok') return { approvalFlag: flag };
    if (hiddenHelp.status === 'transient-failure') {
      return { warning: OPENCODE_AUTO_APPROVE_PROBE_FAILED_MESSAGE, cacheable: false };
    }
  }

  return { warning: OPENCODE_AUTO_APPROVE_UNAVAILABLE_MESSAGE, cacheable: true };
}

function isOpenCodeAutoApproveProbeCacheable(result: OpenCodeAutoApproveProbeResult): boolean {
  if (result.cacheable !== undefined) return result.cacheable;
  if (result.warning && !result.approvalFlag) return result.warning === OPENCODE_AUTO_APPROVE_UNAVAILABLE_MESSAGE;
  return true;
}

export function cacheOpenCodeAutoApproveProbe(
  probe: Promise<OpenCodeAutoApproveProbeResult>,
  clearCache: (promise: Promise<OpenCodeAutoApproveProbeResult>) => void,
): Promise<OpenCodeAutoApproveProbeResult> {
  const cachedProbe = probe.then(
    (result) => {
      if (!isOpenCodeAutoApproveProbeCacheable(result)) clearCache(cachedProbe);
      return result;
    },
    (err) => {
      clearCache(cachedProbe);
      throw err;
    },
  );
  return cachedProbe;
}
