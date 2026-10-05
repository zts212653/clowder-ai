import { type ChildProcess, fork } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { EntityConflictContext } from '@cat-cafe/shared';
import { EntityConflictInvalidResolutionError, EntityConflictStaleError } from './entity-conflict-mutation.js';
import { type EntitySurfaceConflictDetails, EntitySurfaceConflictError } from './entity-registry-mutation.js';
import type { IEmbeddingService } from './interfaces.js';
import { MemoryProcessDiagnostics } from './memory-process-diagnostics.js';
import {
  type ChildMessage,
  encodeProcessError,
  type MemoryProcessJob,
  type ParentMessage,
  type ProcessError,
  type WalCheckpointResult,
} from './memory-process-protocol.js';

function decodeError(error: ProcessError): Error {
  const details = error.details;
  if (error.name === 'EntitySurfaceConflictError')
    return new EntitySurfaceConflictError(details as unknown as EntitySurfaceConflictDetails);
  if (error.name === 'EntityConflictStaleError')
    return new EntityConflictStaleError(details.conflict as EntityConflictContext | null);
  if (error.name === 'EntityConflictInvalidResolutionError')
    return new EntityConflictInvalidResolutionError(error.message, details.conflict as EntityConflictContext);
  return Object.assign(new Error(error.message), { name: error.name, stack: error.stack }, details);
}

/** Native SQLite work must be killable even while sqlite3_step owns a native stack.
 * A fixed process pool bounds parallel CPU/memory; no query falls back to API-thread SQL. */
class MemoryProcess {
  private child?: ChildProcess;
  private readonly diagnostics = new WeakMap<ChildProcess, MemoryProcessDiagnostics>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private sequence = 0;
  private idleTimer?: NodeJS.Timeout;

  get load(): number {
    return this.pending;
  }

  run<T>(
    job: MemoryProcessJob,
    options?: { signal?: AbortSignal; deadlineAt?: number; embedding?: IEmbeddingService },
  ): Promise<T> {
    if (this.pending >= 64) return Promise.reject(new Error('Memory process queue is full'));
    this.pending++;
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let active: ChildProcess | undefined;
      let cleanupActive = () => {};
      const complete = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener('abort', abort);
        cleanupActive();
        error === undefined ? resolve(value as T) : reject(error);
      };
      const abort = () => {
        const reason = options?.signal?.reason ?? new DOMException('Memory search deadline exceeded', 'TimeoutError');
        controller.abort(reason);
        if (active) {
          // SIGKILL also interrupts native SQLite. Its open transaction rolls back.
          active.kill('SIGKILL');
          if (this.child === active) this.child = undefined;
          // A checkpoint owns native I/O resources. Do not release its scope
          // until the killed process has actually closed its SQLite handles.
          if (job.kind === 'checkpoint') return;
        }
        complete(reason);
      };
      const timer =
        options?.deadlineAt == null ? undefined : setTimeout(abort, Math.max(0, options.deadlineAt - Date.now()));
      options?.signal?.addEventListener('abort', abort, { once: true });
      if (options?.signal?.aborted || (options?.deadlineAt != null && options.deadlineAt <= Date.now())) abort();
      this.tail = this.tail
        .then(async () => {
          if (settled) return;
          const child = this.getChild();
          active = child;
          child.ref();
          child.channel?.ref();
          if (child.stderr instanceof Socket) child.stderr.ref();
          await new Promise<void>((finished) => {
            const id = ++this.sequence;
            const diagnostics = this.diagnostics.get(child)!;
            diagnostics.begin(id);
            const onError = (error: Error) => {
              if (job.kind !== 'checkpoint') return complete(error);
              controller.abort(error);
              child.kill('SIGKILL');
              if (this.child === child) this.child = undefined;
            };
            const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
              complete(
                controller.signal.aborted
                  ? controller.signal.reason
                  : Object.assign(new Error(`Memory process exited (${signal ?? code})`), {
                      stderrTail: diagnostics.tail(id),
                    }),
              );
            const onMessage = (message: ChildMessage) => {
              if (job.kind === 'checkpoint' && controller.signal.aborted) return;
              if (message.type === 'started') {
                channel('cat-cafe.memory-process').publish({ kind: job.kind, pid: message.pid, id });
              } else if (message.type === 'embedding') {
                void this.handleEmbedding(child, message, options?.embedding, controller.signal);
              } else if (message.id === id) {
                complete(message.error ? decodeError(message.error) : undefined, message.value as T);
              }
            };
            cleanupActive = () => {
              child.removeListener('error', onError);
              child.removeListener('close', onClose);
              diagnostics.finish(id);
              child.removeListener('message', onMessage);
              child.unref();
              child.channel?.unref();
              if (child.stderr instanceof Socket) child.stderr.unref();
              this.idleTimer = setTimeout(() => {
                if (this.child === child) {
                  child.kill();
                  this.child = undefined;
                }
              }, 30_000);
              this.idleTimer.unref();
              finished();
            };
            child.once('error', onError);
            child.once('close', onClose);
            child.on('message', onMessage);
            child.send({ type: 'run', id, job, stderrToken: diagnostics.token } satisfies ParentMessage, (error) => {
              if (error) onError(error);
            });
          });
        })
        .catch((error) => complete(error))
        .finally(() => {
          this.pending--;
        });
    });
  }

  private getChild(): ChildProcess {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.child?.connected) return this.child;
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(`./memory-process-entry.${source ? 'ts' : 'js'}`, import.meta.url);
    const child = fork(fileURLToPath(entry), [], {
      execArgv: source ? ['--import', 'tsx'] : [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.diagnostics.set(child, new MemoryProcessDiagnostics(child.stderr!));
    child.on('exit', () => {
      if (this.child === child) this.child = undefined;
    });
    this.child = child;
    return child;
  }

  private async handleEmbedding(
    child: ChildProcess,
    message: Extract<ChildMessage, { type: 'embedding' }>,
    embedding?: IEmbeddingService,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      if (!embedding) throw new Error('Embedding service unavailable');
      const value =
        message.method === 'embed'
          ? await embedding.embed(message.texts ?? [], signal)
          : await embedding[message.method](signal);
      if (child.connected)
        child.send(
          {
            type: 'embedding-result',
            id: message.id,
            value,
            ready: embedding.isReady(),
            model: embedding.getModelInfo(),
          } satisfies ParentMessage,
          () => {},
        );
    } catch (error) {
      if (child.connected)
        child.send(
          {
            type: 'embedding-result',
            id: message.id,
            ready: false,
            error: encodeProcessError(error),
          } satisfies ParentMessage,
          () => {},
        );
    }
  }
}

const reads = [new MemoryProcess(), new MemoryProcess()] as const;
const projections = new MemoryProcess();
const scans = new MemoryProcess();
export function runMemoryRead<T>(
  job: Extract<MemoryProcessJob, { kind: 'search' | 'message-search' }>,
  options?: Parameters<MemoryProcess['run']>[1],
): Promise<T> {
  return (reads[0].load <= reads[1].load ? reads[0] : reads[1]).run<T>(job, options);
}
export function runMemoryProjection<T>(job: Extract<MemoryProcessJob, { kind: 'project-mentions' }>): Promise<T> {
  return projections.run<T>(job);
}
export function runMemoryCheckpoint(
  dbPath: string,
  options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<WalCheckpointResult> {
  return projections.run<WalCheckpointResult>(
    { kind: 'checkpoint', dbPath },
    { ...options, deadlineAt: options.deadlineAt ?? Date.now() + 15_000 },
  );
}
export function runMemoryScan<T>(job: Extract<MemoryProcessJob, { kind: 'scan' }>): Promise<T> {
  return scans.run<T>(job);
}
