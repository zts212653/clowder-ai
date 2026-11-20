import type { TaskSpec_P1 } from '../../../../../infrastructure/scheduler/types.js';
import type { CacheRetentionCoordinator } from './CacheRetentionCoordinator.js';

export function cacheRetentionTask(coordinator: CacheRetentionCoordinator): TaskSpec_P1 {
  return {
    id: 'f338-cache-retention',
    profile: 'poller',
    trigger: { type: 'interval', ms: 60_000 },
    admission: {
      async gate() {
        return { run: true, workItems: [{ signal: null, subjectKey: 'cache-retention' }] };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 240_000,
      async execute() {
        await coordinator.tick();
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    display: {
      label: '缓存保留',
      category: 'system',
      description: '只维护已主动开启、正在等待交回的会话缓存',
      subjectKind: 'none',
    },
  };
}
