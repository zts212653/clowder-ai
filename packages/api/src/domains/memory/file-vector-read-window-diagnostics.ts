const beginReasons = [
  'active',
  'scope_busy',
  'previous_cleanup_failed',
  'not_readonly',
  'not_read_snapshot',
  'no_database_path',
  'unsafe_uri',
  'file_identity_changed',
  'file_unavailable',
] as const;
const fallbacks = ['none', 'unsupported_range', 'map_limit', 'unmap_failed', 'map_failed'] as const;
export interface FileVectorPreloadSnapshot {
  attempted: boolean;
  started: boolean;
  joined: boolean;
  /** Bytes returned by helper pread calls, not device I/O or filesystem-cache size. */
  logicalBytes: number;
  readCalls: number;
  errorCode: number;
}

function preloadSnapshot(raw: unknown): FileVectorPreloadSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { attempted, started, joined, logicalBytes, readCalls, errorCode } = raw as Record<string, unknown>;
  if (
    typeof attempted !== 'boolean' ||
    typeof started !== 'boolean' ||
    typeof joined !== 'boolean' ||
    ![logicalBytes, readCalls, errorCode].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) ||
    (errorCode as number) > 2147483647 ||
    (started && (!attempted || !joined)) ||
    (joined && !started) ||
    (!started && (logicalBytes !== 0 || readCalls !== 0))
  )
    return null;
  return {
    attempted,
    started,
    joined,
    logicalBytes: logicalBytes as number,
    readCalls: readCalls as number,
    errorCode: errorCode as number,
  };
}

export interface FileVectorReadWindowSnapshot {
  prepared: boolean;
  /** Admission of this SELECT's scope, not live ownership after cleanup. */
  active: boolean | null;
  reason:
    | (typeof beginReasons)[number]
    | 'not_configured'
    | 'unsupported_platform'
    | 'in_memory'
    | 'extension_unavailable'
    | 'interface_unavailable'
    | 'not_attempted'
    | 'diagnostic_unavailable';
  cleanup: boolean | null;
  /** Null until an end observation; an observed non-start is an explicit zero-valued object. */
  preload: FileVectorPreloadSnapshot | null;
  counters: {
    mapCalls: number;
    mappedReads: number;
    mainPreadCalls: number;
    nonMainPreadCalls: number;
    firstFallback: (typeof fallbacks)[number];
    counterLimitReached: boolean;
  } | null;
}

export function decodeReadWindowNativeSnapshot(raw: unknown) {
  try {
    if (typeof raw !== 'string' || raw.length > 512) return;
    const value: Record<string, unknown> = JSON.parse(raw);
    const index = value.reason;
    if (typeof index !== 'number' || !Number.isInteger(index) || !beginReasons[index]) return;
    const reason = beginReasons[index]!;
    const counts = [value.maps, value.mapped, value.main, value.nonMain];
    const fallback = value.fallback;
    if (
      index !== 0 ||
      !counts.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 2147483647) ||
      typeof fallback !== 'number' ||
      !Number.isInteger(fallback) ||
      !fallbacks[fallback]
    )
      return { reason, counters: null, preload: null };
    return {
      reason,
      preload: preloadSnapshot(value.preload),
      counters: {
        mapCalls: counts[0] as number,
        mappedReads: counts[1] as number,
        mainPreadCalls: counts[2] as number,
        nonMainPreadCalls: counts[3] as number,
        firstFallback: fallbacks[fallback]!,
        counterLimitReached: counts.some((n) => n === 2147483647),
      },
    };
  } catch {
    // A malformed diagnostic cannot replace the window's native result.
  }
}

/** Private IPC projection: fixed enums and bounded counts, never native text. */
export function safeFileVectorReadWindowSnapshot(raw: unknown): FileVectorReadWindowSnapshot | undefined {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const value = raw as Record<string, unknown>;
    const { prepared, active, reason, cleanup } = value;
    const reasons = [
      ...beginReasons,
      'not_configured',
      'unsupported_platform',
      'in_memory',
      'extension_unavailable',
      'interface_unavailable',
      'not_attempted',
      'diagnostic_unavailable',
    ];
    if (
      typeof prepared !== 'boolean' ||
      (active !== null && typeof active !== 'boolean') ||
      typeof reason !== 'string' ||
      !reasons.includes(reason) ||
      (cleanup !== null && typeof cleanup !== 'boolean')
    )
      return;
    let counters: FileVectorReadWindowSnapshot['counters'] = null;
    if (active && value.counters && typeof value.counters === 'object' && !Array.isArray(value.counters)) {
      const c = value.counters as Record<string, unknown>;
      const values = [c.mapCalls, c.mappedReads, c.mainPreadCalls, c.nonMainPreadCalls];
      if (
        values.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 2147483647) &&
        typeof c.firstFallback === 'string' &&
        fallbacks.some((s) => s === c.firstFallback)
      )
        counters = {
          mapCalls: values[0] as number,
          mappedReads: values[1] as number,
          mainPreadCalls: values[2] as number,
          nonMainPreadCalls: values[3] as number,
          firstFallback: c.firstFallback as NonNullable<FileVectorReadWindowSnapshot['counters']>['firstFallback'],
          counterLimitReached: values.some((n) => n === 2147483647),
        };
    }
    return {
      prepared,
      active,
      reason: reason as FileVectorReadWindowSnapshot['reason'],
      cleanup,
      counters,
      preload: active && cleanup !== null ? preloadSnapshot(value.preload) : null,
    };
  } catch {
    /* A malformed diagnostic cannot change a recall result. */
  }
}
