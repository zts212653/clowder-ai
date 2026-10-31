type SidebarIdbTarget = 'canonical_sidebar' | 'legacy_thread_list';

interface SidebarProjectionCounters {
  clientApplyCount: number;
  sidebarIdbWriteCount: number;
  legacyThreadListIdbWriteCount: number;
}

const counters: SidebarProjectionCounters = {
  clientApplyCount: 0,
  sidebarIdbWriteCount: 0,
  legacyThreadListIdbWriteCount: 0,
};

function emit(stage: 'client_apply' | 'idb_write', fields: Record<string, unknown>): void {
  console.info('[F297] Sidebar projection trace', {
    feature: 'F297',
    measurement: 'sidebar_snapshot_client',
    stage,
    ...fields,
    ...counters,
  });
}

export function recordSidebarClientApply(rowCount: number, durationMs: number): void {
  counters.clientApplyCount += 1;
  emit('client_apply', { rowCount, durationMs });
}

export function recordSidebarIdbWrite(target: SidebarIdbTarget, rowCount: number, durationMs: number): void {
  if (target === 'canonical_sidebar') counters.sidebarIdbWriteCount += 1;
  else counters.legacyThreadListIdbWriteCount += 1;
  emit('idb_write', { target, rowCount, durationMs });
}

export function __resetSidebarProjectionObservabilityForTests(): void {
  counters.clientApplyCount = 0;
  counters.sidebarIdbWriteCount = 0;
  counters.legacyThreadListIdbWriteCount = 0;
}
