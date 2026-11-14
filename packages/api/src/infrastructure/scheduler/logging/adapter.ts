import { type BaseLogger, stdSerializers } from 'pino';
import type { RecoveryLoopObservation } from '../../recovery/recovery-loop.js';
import type { TaskRunnerV2Options } from '../TaskRunnerV2.js';

function diagnosticFields(value: unknown): Record<string, unknown> {
  const serialized = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const fields: Record<string, unknown> = Object.create(null);
  fields.name = fields.type = typeof serialized.type === 'string' ? serialized.type : 'UnknownError';
  fields.message = serialized.message;
  fields.stack = serialized.stack;
  if (Array.isArray(serialized.aggregateErrors))
    fields.aggregateErrors = serialized.aggregateErrors.map(diagnosticFields);
  return fields;
}

/** Use installed Pino cause/aggregate semantics, retaining only diagnostic fields and never raw/custom payload. */
export function schedulerError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return diagnosticFields(stdSerializers.err(error));
  return diagnosticFields({
    type: 'UnknownError',
    message: typeof error === 'string' ? error : 'Non-Error scheduler failure',
  });
}

export function createSchedulerLogger(log: Pick<BaseLogger, 'info' | 'error'>): TaskRunnerV2Options['logger'] {
  return {
    info: (message) => log.info(message),
    error: (message, error) => {
      if (error === undefined) log.error(message);
      else log.error({ err: schedulerError(error) }, message);
    },
  };
}

export function createRecoveryLoopObserver(log: Pick<BaseLogger, 'info' | 'error'>) {
  return ({ loopId, elapsedMs, stats, error }: RecoveryLoopObservation): void => {
    const fields = { loopId, elapsedMs, ...stats };
    if (error !== undefined) log.error({ ...fields, err: schedulerError(error) }, 'Recovery loop failed');
    else log.info(fields, 'Recovery loop completed');
  };
}
