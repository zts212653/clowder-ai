export interface MacPowerSleepInterval {
  readonly evidenceId: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly wakeKind: 'dark' | 'full';
}

export type MacPowerEvidence =
  | {
      readonly status: 'available';
      readonly confirmedSleep: readonly MacPowerSleepInterval[];
      readonly pendingSleep?: { readonly startedAt: number };
    }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface MacPowerEvidenceCommandOptions {
  readonly platform?: string;
  readonly exists?: (file: string) => boolean;
  readonly execute?: (
    file: string,
    args: readonly string[],
    options: {
      readonly encoding: 'utf8';
      readonly killSignal: 'SIGKILL';
      readonly maxBuffer: number;
      readonly timeout: number;
      readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
    },
  ) => string;
  readonly now?: () => number;
  readonly wait?: (ms: number) => void;
}

export function parseMacSleepEvidence(output: string): MacPowerEvidence;
export function readMacSleepEvidence(
  window: { readonly from: number; readonly to: number; readonly timeoutMs?: number },
  options?: MacPowerEvidenceCommandOptions,
): MacPowerEvidence;
