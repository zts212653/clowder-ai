import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../infrastructure/logger.js';

export type SettledIndexCheckpoint = {
  complete: boolean;
  batches: number;
  detailReads: number;
  pendingKeys: number;
};
type Job = { step: () => Promise<SettledIndexCheckpoint>; reportedAt: number; generation: number };
type Worker = {
  redis: RedisClient;
  jobs: Map<string, Job>;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  closed: boolean;
  close: () => void;
};

const workers = new WeakMap<RedisClient, Worker>();
const log = createModuleLogger('settled-history-backfill');
const STEP_INTERVAL_MS = 20;
const PROGRESS_INTERVAL_MS = 5_000;

function stop(worker: Worker): void {
  worker.closed = true;
  clearTimeout(worker.timer);
  worker.redis.removeListener('close', worker.close);
  worker.redis.removeListener('end', worker.close);
  workers.delete(worker.redis);
  worker.jobs.clear();
}

function schedule(worker: Worker): void {
  if (worker.closed || worker.running || worker.timer) return;
  worker.timer = setTimeout(() => {
    worker.timer = undefined;
    void advance(worker);
  }, STEP_INTERVAL_MS);
  worker.timer.unref();
}

function commitStep(worker: Worker, progressKey: string, job: Job, checkpoint: SettledIndexCheckpoint): void {
  const now = Date.now();
  if (checkpoint.complete || now - job.reportedAt >= PROGRESS_INTERVAL_MS) {
    log.info({ progressKey, phase: checkpoint.complete ? 'complete' : 'progress', ...checkpoint }, 'History backfill');
    job.reportedAt = now;
  }
  worker.jobs.delete(progressKey);
  if (!checkpoint.complete) worker.jobs.set(progressKey, job);
}

async function advance(worker: Worker): Promise<void> {
  const next = worker.jobs.entries().next().value;
  if (!next || worker.closed) return;
  const [progressKey, job] = next;
  const generation = job.generation;
  worker.running = true;
  try {
    const checkpoint = await job.step();
    if (worker.closed) return;
    commitStep(worker, progressKey, job, checkpoint);
  } catch (error) {
    if (worker.closed) return;
    const retryRequested = job.generation !== generation;
    // Do not serialize source parsing errors: their messages may quote private records.
    log.error(
      { progressKey, phase: 'failed', retryRequested, errorType: error instanceof Error ? error.name : 'unknown' },
      'History backfill batch failed',
    );
    worker.jobs.delete(progressKey);
    // A later explicit read owns one retry with its latest source; failures alone never reschedule.
    if (retryRequested) worker.jobs.set(progressKey, job);
  } finally {
    worker.running = false;
    if (!worker.closed) {
      if (worker.jobs.size) schedule(worker);
      else stop(worker);
    }
  }
}

/** Continue the existing persisted migration after its first read, even if that page closes. */
export function continueSettledIndex(
  redis: RedisClient,
  progressKey: string,
  step: () => Promise<SettledIndexCheckpoint>,
): void {
  if (redis.status === 'end' || redis.status === 'close') return;
  let worker = workers.get(redis);
  if (!worker) {
    const created: Worker = {
      redis,
      jobs: new Map(),
      running: false,
      closed: false,
      close: () => {
        log.info(
          { phase: 'stopped', progressKeys: [...created.jobs.keys()], reason: 'redis_closed' },
          'History backfill stopped',
        );
        stop(created);
      },
    };
    worker = created;
    workers.set(redis, worker);
    redis.once('close', worker.close);
    redis.once('end', worker.close);
  }
  const existing = worker.jobs.get(progressKey);
  if (existing) {
    existing.step = step;
    existing.generation++;
  } else {
    worker.jobs.set(progressKey, { step, reportedAt: Date.now(), generation: 0 });
    log.info({ progressKey, phase: 'started' }, 'History backfill');
  }
  schedule(worker);
}
