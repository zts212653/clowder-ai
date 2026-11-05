import { resourceUsage } from 'node:process';

export interface NativeReadResources {
  userCpuUs: number;
  systemCpuUs: number;
  fsReadOperations: number;
  fsWriteOperations: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
  maxRssKiB: number;
}

export type NativeReadResourceDelta = Omit<NativeReadResources, 'maxRssKiB'>;

/** Process counters, not provider usage, bytes read or exclusive native CPU. */
export function captureNativeReadResources(read = resourceUsage): NativeReadResources | null {
  try {
    const value = read();
    const result: NativeReadResources = {
      userCpuUs: value.userCPUTime,
      systemCpuUs: value.systemCPUTime,
      fsReadOperations: value.fsRead,
      fsWriteOperations: value.fsWrite,
      voluntaryContextSwitches: value.voluntaryContextSwitches,
      involuntaryContextSwitches: value.involuntaryContextSwitches,
      maxRssKiB: value.maxRSS,
    };
    return Object.values(result).every((n) => Number.isFinite(n) && n >= 0) ? result : null;
  } catch {
    return null;
  }
}

export function nativeReadResourceDelta(
  before: NativeReadResources | null,
  after: NativeReadResources | null,
): NativeReadResourceDelta | null {
  if (!before || !after) return null;
  const { maxRssKiB: _highWater, ...counters } = before;
  const delta = Object.fromEntries(
    Object.entries(counters).map(([key, value]) => [key, after[key as keyof NativeReadResourceDelta] - value]),
  ) as unknown as NativeReadResourceDelta;
  return Object.values(delta).every((n) => Number.isFinite(n) && n >= 0) ? delta : null;
}
