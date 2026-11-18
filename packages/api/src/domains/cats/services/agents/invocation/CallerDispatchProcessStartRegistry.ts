import type {
  CallerDispatchObservationScope,
  CallerDispatchProcessStartProjection,
} from './caller-dispatch-observation-model.js';
import { callerDispatchObservationSlotKey } from './caller-dispatch-observation-model.js';

interface CallerDispatchProcessStartState {
  processGenerationId: string;
  noticeAcknowledged: boolean;
  touchedAt: number;
}

const MAX_PROCESS_START_SLOTS = 512;
const PROCESS_START_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;

export class CallerDispatchProcessStartRegistry {
  private readonly bySlot = new Map<string, CallerDispatchProcessStartState>();

  private prune(now = Date.now()): void {
    const cutoff = now - PROCESS_START_IDLE_TTL_MS;
    for (const [slotKey, state] of this.bySlot) {
      if (state.touchedAt < cutoff) this.bySlot.delete(slotKey);
    }
  }

  project(scope: CallerDispatchObservationScope, processGenerationId: string): CallerDispatchProcessStartProjection {
    const slotKey = callerDispatchObservationSlotKey(scope);
    let state = this.bySlot.get(slotKey);
    if (!state || state.processGenerationId !== processGenerationId) {
      this.prune();
      if (!this.bySlot.has(slotKey) && this.bySlot.size >= MAX_PROCESS_START_SLOTS) {
        const oldest = [...this.bySlot].sort(([, left], [, right]) => left.touchedAt - right.touchedAt)[0];
        if (oldest) this.bySlot.delete(oldest[0]);
      }
      state = { processGenerationId, noticeAcknowledged: false, touchedAt: Date.now() };
      this.bySlot.set(slotKey, state);
    }
    state.touchedAt = Date.now();
    if (state.noticeAcknowledged) return { prompt: '' };

    return {
      prompt: [
        '[A2A Observation Scope]',
        `process_start processGeneration=${processGenerationId}`,
        '派发状态只含本次 API 进程启动后登记的派发；更早的派发结果在线程历史里。',
        '[/A2A Observation Scope]',
      ].join('\n'),
    };
  }

  acknowledge(scope: CallerDispatchObservationScope, processGenerationId: string): void {
    const state = this.bySlot.get(callerDispatchObservationSlotKey(scope));
    if (state?.processGenerationId === processGenerationId) {
      state.noticeAcknowledged = true;
      state.touchedAt = Date.now();
    }
  }
}
