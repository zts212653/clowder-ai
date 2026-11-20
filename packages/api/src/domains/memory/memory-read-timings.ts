type PointName = 'vectorsStarted' | 'scopeEndObservation' | 'resultPrepared';
type BridgeMethod = 'load' | 'reprobeIfNeeded' | 'embed';
type BridgeOutcome = 'fulfilled' | 'rejected';
interface ObservedPoint {
  parentReceivedMs: number;
  workerElapsedMs: number | null;
}
interface EmbeddingCallTiming {
  rpcId: number;
  method: BridgeMethod;
  parentReceivedMs: number;
  parentSettledMs: number | null;
  outcome: BridgeOutcome | null;
}
export interface MemoryReadTimingSnapshot {
  parentClock: 'monotonic-since-submit';
  workerClock: 'monotonic-since-run';
  vectorsStarted: ObservedPoint | null;
  scopeEndObservation: ObservedPoint | null;
  resultPrepared: ObservedPoint | null;
  resultReceivedMs: number | null;
  cancelRequestedMs: number | null;
  settledMs: number | null;
  embeddingCalls: EmbeddingCallTiming[];
  embeddingCallLimit: 8;
  embeddingCallsTruncated: boolean;
}

const duration = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const method = (v: unknown): v is BridgeMethod => v === 'load' || v === 'reprobeIfNeeded' || v === 'embed';
const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** One existing execution's observations, not a clock conversion or another lifetime owner. */
export class MemoryReadTimings {
  private readonly value: MemoryReadTimingSnapshot = {
    parentClock: 'monotonic-since-submit',
    workerClock: 'monotonic-since-run',
    vectorsStarted: null,
    scopeEndObservation: null,
    resultPrepared: null,
    resultReceivedMs: null,
    cancelRequestedMs: null,
    settledMs: null,
    embeddingCalls: [],
    embeddingCallLimit: 8,
    embeddingCallsTruncated: false,
  };

  constructor(private readonly submitted: number) {}

  get closed() {
    return this.value.settledMs !== null;
  }

  point(name: PointName, workerElapsedMs?: number) {
    if (this.closed || (name === 'vectorsStarted' && this.value.vectorsStarted !== null)) return;
    this.value[name] = {
      parentReceivedMs: performance.now() - this.submitted,
      workerElapsedMs: duration(workerElapsedMs) ? workerElapsedMs : null,
    };
  }

  beginScope() {
    if (!this.closed) this.value.scopeEndObservation = null;
  }

  mark(name: 'resultReceivedMs' | 'cancelRequestedMs' | 'settledMs') {
    if (!this.closed && this.value[name] === null) this.value[name] = performance.now() - this.submitted;
  }

  embeddingStarted(rpcId: number, name: string) {
    if (this.closed || !method(name)) return;
    if (this.value.embeddingCalls.length === this.value.embeddingCallLimit) {
      this.value.embeddingCallsTruncated = true;
      return;
    }
    this.value.embeddingCalls.push({
      rpcId,
      method: name,
      parentReceivedMs: performance.now() - this.submitted,
      parentSettledMs: null,
      outcome: null,
    });
  }

  embeddingFinished(rpcId: number, outcome: BridgeOutcome) {
    if (this.closed) return;
    const call = this.value.embeddingCalls.find((row) => row.rpcId === rpcId);
    if (!call || call.parentSettledMs !== null) return;
    call.parentSettledMs = performance.now() - this.submitted;
    call.outcome = outcome;
  }

  snapshot(): MemoryReadTimingSnapshot {
    const v = this.value;
    return {
      ...v,
      vectorsStarted: v.vectorsStarted && { ...v.vectorsStarted },
      scopeEndObservation: v.scopeEndObservation && { ...v.scopeEndObservation },
      resultPrepared: v.resultPrepared && { ...v.resultPrepared },
      embeddingCalls: v.embeddingCalls.map((call) => ({ ...call })),
    };
  }
}

function embeddingTiming(raw: unknown): EmbeddingCallTiming | undefined {
  const call = record(raw);
  if (!call) return;
  const { rpcId, method: name, parentReceivedMs, parentSettledMs, outcome } = call;
  if (
    !duration(rpcId) ||
    !Number.isSafeInteger(rpcId) ||
    rpcId === 0 ||
    !method(name) ||
    !duration(parentReceivedMs) ||
    (parentSettledMs === null
      ? outcome !== null
      : !duration(parentSettledMs) ||
        parentSettledMs < parentReceivedMs ||
        (outcome !== 'fulfilled' && outcome !== 'rejected'))
  )
    return;
  return {
    rpcId,
    method: name,
    parentReceivedMs,
    parentSettledMs: parentSettledMs as number | null,
    outcome: outcome as BridgeOutcome | null,
  };
}

/** Fixed private progress scalars only; missing/invalid observations never become zeros. */
export function safeMemoryReadTimings(raw: unknown): MemoryReadTimingSnapshot | undefined {
  try {
    const v = record(raw);
    if (!v || v.parentClock !== 'monotonic-since-submit' || v.workerClock !== 'monotonic-since-run') return;
    const point = (rawPoint: unknown): ObservedPoint | null | undefined => {
      if (rawPoint === null) return null;
      const p = record(rawPoint);
      if (!p) return;
      const { parentReceivedMs, workerElapsedMs } = p;
      if (!duration(parentReceivedMs) || (workerElapsedMs !== null && !duration(workerElapsedMs))) return;
      return { parentReceivedMs, workerElapsedMs: workerElapsedMs as number | null };
    };
    const vectorsStarted = point(v.vectorsStarted),
      scopeEndObservation = point(v.scopeEndObservation),
      resultPrepared = point(v.resultPrepared);
    const {
      resultReceivedMs,
      cancelRequestedMs,
      settledMs,
      embeddingCalls,
      embeddingCallLimit,
      embeddingCallsTruncated,
    } = v;
    if (
      vectorsStarted === undefined ||
      scopeEndObservation === undefined ||
      resultPrepared === undefined ||
      ![resultReceivedMs, cancelRequestedMs, settledMs].every((n) => n === null || duration(n)) ||
      !Array.isArray(embeddingCalls) ||
      embeddingCallLimit !== 8 ||
      typeof embeddingCallsTruncated !== 'boolean'
    )
      return;
    const callCount = embeddingCalls.length;
    if (!Number.isSafeInteger(callCount) || callCount < 0 || callCount > 8) return;
    const calls: EmbeddingCallTiming[] = [];
    for (let i = 0; i < callCount; i++) {
      const call = embeddingTiming(embeddingCalls[i]);
      if (!call) return;
      calls.push(call);
    }
    return {
      parentClock: 'monotonic-since-submit',
      workerClock: 'monotonic-since-run',
      vectorsStarted,
      scopeEndObservation,
      resultPrepared,
      resultReceivedMs: resultReceivedMs as number | null,
      cancelRequestedMs: cancelRequestedMs as number | null,
      settledMs: settledMs as number | null,
      embeddingCalls: calls,
      embeddingCallLimit: 8,
      embeddingCallsTruncated,
    };
  } catch {
    /* Diagnostic getters cannot change a stopped search. */
    return;
  }
}
