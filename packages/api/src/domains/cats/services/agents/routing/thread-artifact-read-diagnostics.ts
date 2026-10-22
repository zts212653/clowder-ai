import type { FastifyBaseLogger } from 'fastify';

type Stage =
  | 'messages'
  | 'tasks'
  | 'memory'
  | 'liveFiles'
  | 'acceptedFiles'
  | 'prTitles'
  | 'independentWorks'
  | 'lineage';

/** Stage wall time is not CPU time. Retain no messages, source coordinates or error payloads. */
export async function observeThreadArtifactRead<T>(
  logger: Pick<FastifyBaseLogger, 'info'>,
  read: (measure: <R>(stage: Stage, operation: () => R | Promise<R>) => Promise<R>) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const stages: Partial<Record<Stage, number>> = {};
  let status = 'failed';
  try {
    const result = await read(async (stage, operation) => {
      const before = performance.now();
      try {
        return await operation();
      } finally {
        stages[stage] = (stages[stage] ?? 0) + performance.now() - before;
      }
    });
    status = 'success';
    return result;
  } finally {
    const handlerElapsedMs = performance.now() - started;
    if (handlerElapsedMs >= 1000) {
      try {
        logger.info({ handlerElapsedMs, stages, status }, '[Task229] thread artifact read diagnostic');
      } catch {
        /* Diagnostics must not replace the read result or failure. */
      }
    }
  }
}
