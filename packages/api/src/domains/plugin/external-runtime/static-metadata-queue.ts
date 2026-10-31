import {
  MAX_WORK_COUNT,
  MAX_WORK_MS,
  type SealCaller,
  type SealQueueWait,
  type SealReadDiagnostics,
  type SealSlotRelease,
  sealCaller,
  workMs,
} from '../diagnostics/observation-work.js';

const CALLERS: readonly SealCaller[] = ['observer', 'presence', 'other'];
type Operation = 'lstat' | 'readdir';
export class MetadataScan {
  readonly caller: SealCaller;
  readonly callers = new Set<SealCaller>();
  consumerPeak = 0;
  ioPeak = 0;
  lstatCalls = 0;
  readdirCalls = 0;
  queueWaitMs = 0;
  maxQueueWaitMs = 0;
  longestQueueWait?: SealQueueWait;
  ioAwaitMs = 0;
  maxIoAwaitMs = 0;
  capped = false;
  recordable = true;

  constructor(caller: SealCaller) {
    this.caller = sealCaller(caller);
  }

  sample(): number | undefined {
    try {
      const value = performance.now();
      if (Number.isFinite(value)) return value;
    } catch {
      /* A diagnostic clock cannot change an IO result or consume a slot. */
    }
    this.recordable = false;
    return undefined;
  }

  add(field: 'lstatCalls' | 'readdirCalls' | 'queueWaitMs' | 'ioAwaitMs', amount: number): void {
    const limit = field.endsWith('Calls') ? MAX_WORK_COUNT : MAX_WORK_MS;
    const next = this[field] + amount;
    if (next > limit) this.capped = true;
    this[field] = Math.min(limit, next);
  }
}

/** One private generation: four FIFO IO slots and only live per-consumer summaries. */
export class StaticMetadataQueue {
  private active = 0;
  private readonly waiting: Array<(releasedBy?: SealSlotRelease) => void> = [];
  private readonly scans = new Set<MetadataScan>();

  begin(caller: SealCaller = 'other'): MetadataScan {
    const scan = new MetadataScan(caller);
    this.scans.add(scan);
    for (const live of this.scans) {
      if (this.scans.size > MAX_WORK_COUNT) live.capped = true;
      live.consumerPeak = Math.max(live.consumerPeak, Math.min(MAX_WORK_COUNT, this.scans.size));
      live.callers.add(scan.caller);
      scan.callers.add(live.caller);
    }
    return scan;
  }

  async run<T>(scan: MetadataScan, kind: Operation, operation: () => Promise<T>): Promise<T> {
    const queued = scan.sample();
    let granted = queued;
    let waitingAhead = 0;
    let releasedBy: SealSlotRelease | undefined;
    if (this.active < 4) this.active++;
    else {
      waitingAhead = this.waiting.length;
      await new Promise<void>((resolve) =>
        this.waiting.push((release) => {
          granted = scan.sample();
          releasedBy = release;
          resolve();
        }),
      );
    }
    let ioElapsed: number | undefined;
    try {
      const acquired = scan.sample();
      if (queued !== undefined && acquired !== undefined) {
        const waiting = Math.max(0, acquired - queued);
        if (waiting > MAX_WORK_MS) scan.capped = true;
        scan.add('queueWaitMs', waiting);
        if (waiting > scan.maxQueueWaitMs && granted !== undefined) {
          const slotWaitMs = Math.max(0, granted - queued);
          const resumeDelayMs = Math.max(0, acquired - granted);
          if (waitingAhead > MAX_WORK_COUNT || Math.max(slotWaitMs, resumeDelayMs) > MAX_WORK_MS || releasedBy?.capped)
            scan.capped = true;
          scan.longestQueueWait = {
            queueWaitMs: workMs(waiting),
            slotWaitMs: workMs(slotWaitMs),
            resumeDelayMs: workMs(resumeDelayMs),
            waitingAhead: Math.min(MAX_WORK_COUNT, waitingAhead),
            ...(releasedBy ? { releasedBy } : {}),
          };
        }
        scan.maxQueueWaitMs = Math.max(scan.maxQueueWaitMs, waiting);
      }
      scan.add(kind === 'lstat' ? 'lstatCalls' : 'readdirCalls', 1);
      // Occupancy observed at this consumer's own dispatches, not an IO-wide trace.
      scan.ioPeak = Math.max(scan.ioPeak, this.active);
      try {
        return await operation();
      } finally {
        const finished = scan.sample();
        if (acquired !== undefined && finished !== undefined) {
          const elapsed = Math.max(0, finished - acquired);
          ioElapsed = elapsed;
          if (elapsed > MAX_WORK_MS) scan.capped = true;
          scan.add('ioAwaitMs', elapsed);
          scan.maxIoAwaitMs = Math.max(scan.maxIoAwaitMs, elapsed);
        }
      }
    } finally {
      const next = this.waiting.shift();
      if (next)
        next(
          ioElapsed === undefined
            ? undefined
            : { caller: scan.caller, operation: kind, ioAwaitMs: workMs(ioElapsed), capped: ioElapsed > MAX_WORK_MS },
        );
      else this.active--;
    }
  }

  finish(scan: MetadataScan, diagnostics?: SealReadDiagnostics): void {
    this.scans.delete(scan);
    if (!scan.recordable) return;
    // Diagnostic consumers cannot replace a read failure or prevent reader cleanup.
    try {
      diagnostics?.record({
        caller: scan.caller,
        callers: CALLERS.filter((caller) => scan.callers.has(caller)),
        consumerPeak: scan.consumerPeak,
        ioPeak: scan.ioPeak,
        lstatCalls: scan.lstatCalls,
        readdirCalls: scan.readdirCalls,
        queueWaitMs: workMs(scan.queueWaitMs),
        maxQueueWaitMs: workMs(scan.maxQueueWaitMs),
        ...(scan.longestQueueWait ? { longestQueueWait: scan.longestQueueWait } : {}),
        ioAwaitMs: workMs(scan.ioAwaitMs),
        maxIoAwaitMs: workMs(scan.maxIoAwaitMs),
        capped: scan.capped,
      });
    } catch {
      /* Evidence must never change the original verdict. */
    }
  }
}
