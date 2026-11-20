import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DurableManagedGateJob } from '../managed-job-types.js';

export interface ManagedJobActiveExecution {
  job: DurableManagedGateJob;
  startedAt: number;
}

export interface ManagedJobActiveReadInput {
  dataRoot: string;
  maxConcurrent: number;
  operatorUserId?: string;
  supervisorEpoch: string;
}

export type ManagedJobActiveReadReply = { kind: 'active_read_result'; id: number } & (
  | { ok: true; value: ManagedJobActiveExecution[] }
  | { ok: false; error: { name: string; message: string; code?: string } }
);

const readers = new Map<string, ActiveLedgerReader>();
const READ_BUDGET_MS = 15_000;
const IDLE_MS = 10_000;

class ReadBatch {
  readonly promise: Promise<ManagedJobActiveExecution[]>;
  resolve!: (rows: ManagedJobActiveExecution[]) => void;
  reject!: (error: Error) => void;
  constructor(readonly id: number) {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** One reusable worker per ledger; at most the current batch and one not-yet-started batch. */
class ActiveLedgerReader {
  readonly worker: Worker;
  readonly closed: Promise<void>;
  private finishClose!: () => void;
  private active?: ReadBatch;
  private queued?: ReadBatch;
  private nextId = 0;
  private timer?: NodeJS.Timeout;
  private idle?: NodeJS.Timeout;
  private failure?: Error;
  closing = false;

  constructor(
    private readonly key: string,
    input: ManagedJobActiveReadInput,
  ) {
    this.closed = new Promise((resolve) => {
      this.finishClose = resolve;
    });
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    this.worker = new Worker(new URL(`../../../utils/module-worker.${extension}`, import.meta.url), {
      workerData: {
        moduleUrl: new URL(`./active-reader-worker.${extension}`, import.meta.url).href,
        exportName: 'serveManagedJobActiveReads',
        input,
      },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.worker.on('message', (reply: unknown) => this.receive(reply));
    this.worker.once('error', (error) => this.close(error));
    this.worker.once('exit', (code) => {
      this.closing = true;
      clearTimeout(this.timer);
      clearTimeout(this.idle);
      if (readers.get(this.key) === this) readers.delete(this.key);
      const error = this.failure ?? new Error(`Managed active reader exited (${code})`);
      this.active?.reject(error);
      this.queued?.reject(error);
      this.active = undefined;
      this.queued = undefined;
      this.finishClose();
    });
  }

  read(): Promise<ManagedJobActiveExecution[]> {
    clearTimeout(this.idle);
    this.worker.ref();
    // Never join an already dispatched read: its snapshot may predate this caller's cancellation.
    this.queued ??= new ReadBatch(++this.nextId);
    const result = this.queued.promise;
    queueMicrotask(() => this.dispatch());
    return result;
  }

  private dispatch(): void {
    if (this.closing || this.active || !this.queued) return;
    this.active = this.queued;
    this.queued = undefined;
    this.timer = setTimeout(
      () => this.close(new Error(`Managed active read exceeded ${READ_BUDGET_MS}ms`)),
      READ_BUDGET_MS,
    );
    try {
      this.worker.postMessage({ kind: 'read', id: this.active.id });
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private receive(value: unknown): void {
    if (this.closing) return;
    const reply = value as ManagedJobActiveReadReply | null;
    if (!this.active || !reply || reply.kind !== 'active_read_result' || reply.id !== this.active.id) {
      this.close(new Error('Managed active reader returned an invalid response'));
      return;
    }
    clearTimeout(this.timer);
    const batch = this.active;
    this.active = undefined;
    if (reply.ok) batch.resolve(reply.value);
    else batch.reject(Object.assign(new Error(reply.error.message), reply.error));
    if (this.queued) this.dispatch();
    else {
      this.worker.unref();
      this.idle = setTimeout(() => this.close(), IDLE_MS).unref();
    }
  }

  private close(error?: Error): void {
    if (this.closing) return;
    this.closing = true;
    this.failure = error;
    clearTimeout(this.timer);
    clearTimeout(this.idle);
    if (error) void this.worker.terminate();
    else {
      this.timer = setTimeout(() => {
        void this.worker.terminate();
      }, 5000).unref();
      try {
        this.worker.postMessage({ kind: 'close' });
      } catch {
        void this.worker.terminate();
      }
    }
  }
}

/** Reuse the reader, never its results. A replacement cannot start before the old worker exits. */
export async function readManagedJobActiveExecutionsOffLoop(
  input: ManagedJobActiveReadInput,
): Promise<ManagedJobActiveExecution[]> {
  const key = resolve(input.dataRoot, 'managed-jobs', 'supervisor.sqlite');
  for (;;) {
    let reader = readers.get(key);
    if (reader?.closing) {
      reader.worker.ref();
      await reader.closed;
      continue;
    }
    if (!reader) {
      reader = new ActiveLedgerReader(key, input);
      readers.set(key, reader);
    }
    return reader.read();
  }
}
