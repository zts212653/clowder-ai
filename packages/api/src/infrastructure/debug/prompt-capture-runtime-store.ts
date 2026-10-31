import { runModuleWorker } from '../../utils/run-module-worker.js';
import { createModuleLogger } from '../logger.js';
import {
  type CaptureIndexEntry,
  type PromptCapture,
  PromptCaptureFileStore,
  type PromptCaptureStoreOptions,
} from './prompt-capture-store.js';

const log = createModuleLogger('debug:prompt-capture-runtime');
const queues = new Map<string, { tail: Promise<unknown>; size: number }>();
type Operation =
  | { method: 'read'; args: [string, string?] }
  | { method: 'listByInvocation'; args: [string, string?] }
  | { method: 'listByThread'; args: [string, number, string?] }
  | { method: 'listRecent'; args: [number] }
  | { method: 'stats' | 'prune'; args: [] }
  | { method: 'captureSync'; args: [PromptCapture] };

/** Serializes the legacy index's reads/appends/pruning; all heavy work stays in a worker. */
export class PromptCaptureStore {
  private readonly files: PromptCaptureFileStore;
  constructor(options?: PromptCaptureStoreOptions) {
    this.files = new PromptCaptureFileStore(options);
  }

  private run<T>(operation: Operation): Promise<T> {
    const options = this.files.workerOptions();
    const key = options.baseDir;
    const queue = queues.get(key) ?? { tail: Promise.resolve(), size: 0 };
    if (queue.size >= 64) return Promise.reject(new Error('Prompt capture operation queue is full'));
    queue.size++;
    queues.set(key, queue);
    const pending = queue.tail
      .catch(() => {})
      .then(() =>
        runModuleWorker<T>({
          moduleUrl: new URL(import.meta.url),
          exportName: 'runPromptCaptureOperation',
          input: { options, operation },
        }),
      );
    queue.tail = pending;
    void pending
      .finally(() => {
        if (--queue.size === 0) queues.delete(key);
      })
      .catch(() => {});
    return pending;
  }

  /** Fixture-only synchronous write; production's deprecated bridge remains fire-and-forget. */
  captureSync(data: PromptCapture): string {
    return this.files.captureSync(data);
  }
  captureAsync(data: PromptCapture): void {
    void this.run<string>({ method: 'captureSync', args: [data] }).catch((error) => {
      log.warn({ err: error, captureId: data.captureId }, 'Prompt capture write failed');
    });
  }
  read(captureId: string, userId?: string): Promise<PromptCapture | null> {
    return this.run({ method: 'read', args: [captureId, userId] });
  }
  listByInvocation(invocationId: string, userId?: string): Promise<CaptureIndexEntry[]> {
    return this.run({ method: 'listByInvocation', args: [invocationId, userId] });
  }
  listByThread(threadId: string, limit = 20, userId?: string): Promise<CaptureIndexEntry[]> {
    return this.run({ method: 'listByThread', args: [threadId, limit, userId] });
  }
  listRecent(limit = 20): Promise<CaptureIndexEntry[]> {
    return this.run({ method: 'listRecent', args: [limit] });
  }
  stats(): Promise<{ entries: number; totalBytes: number }> {
    return this.run({ method: 'stats', args: [] });
  }
  prune(): Promise<number> {
    return this.run({ method: 'prune', args: [] });
  }
}

export function runPromptCaptureOperation(input: {
  options: PromptCaptureStoreOptions;
  operation: Operation;
}): unknown {
  const files = new PromptCaptureFileStore(input.options);
  const operation = input.operation;
  switch (operation.method) {
    case 'read':
      return files.read(...operation.args);
    case 'listByInvocation':
      return files.listByInvocation(...operation.args);
    case 'listByThread':
      return files.listByThread(...operation.args);
    case 'listRecent':
      return files.listRecent(...operation.args);
    case 'stats':
      return files.stats();
    case 'prune':
      return files.prune();
    case 'captureSync':
      return files.captureSync(...operation.args);
  }
}
