import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ServiceLifecycleRunner, ServiceLifecycleRunResult } from '../domains/services/service-lifecycle.js';
import { isValidModelId } from '../domains/services/service-lifecycle.js';
import { MODEL_ENV_VARS } from '../domains/services/service-manifest.js';

export const DEFAULT_LIFECYCLE_TIMEOUT_MS = 30 * 60 * 1000;
const LIFECYCLE_RUN_SETTLEMENT = Symbol('lifecycleRunSettlement');

function resolveSessionUserId(request: FastifyRequest): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  return typeof userId === 'string' && userId.trim() ? userId.trim() : null;
}

export function requireLifecycleOwner(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = resolveSessionUserId(request);
  if (!userId) {
    reply.status(401);
    return null;
  }
  const ownerId = process.env.DEFAULT_OWNER_USER_ID?.trim();
  if (!ownerId || userId !== ownerId) {
    reply.status(403);
    return null;
  }
  return userId;
}

export function lifecycleOwnerError(reply: FastifyReply): { error: string } {
  if (reply.statusCode === 401) return { error: 'Authentication required' };
  return {
    error: 'Service lifecycle writes require DEFAULT_OWNER_USER_ID to be configured and match the session owner',
  };
}

export function buildLifecycleEnv(
  baseEnv: NodeJS.ProcessEnv,
  serviceId: string,
  model: unknown,
): { ok: true; env: NodeJS.ProcessEnv } | { ok: false; error: string } {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (typeof model === 'string' && model.length > 0) {
    if (!isValidModelId(model)) return { ok: false, error: 'Invalid model ID format (expected: org/model-name)' };
    const envKey = MODEL_ENV_VARS[serviceId];
    if (envKey) env[envKey] = model;
  } else if (model != null) {
    return { ok: false, error: 'Invalid model ID format (expected: org/model-name)' };
  }
  return { ok: true, env };
}

export async function runWithTimeout(
  runner: ServiceLifecycleRunner,
  input: Parameters<ServiceLifecycleRunner>[0],
): Promise<ServiceLifecycleRunResult> {
  // The outer timer covers injected or custom runners; execFile.timeout still kills real child processes.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let runnerSettled = false;
  const runnerPromise = Promise.resolve()
    .then(() => runner(input))
    .catch((): ServiceLifecycleRunResult => ({ code: null, output: '', runnerError: true }))
    .finally(() => {
      runnerSettled = true;
    });
  const settlement = runnerPromise.then(
    () => undefined,
    () => undefined,
  );
  try {
    const timeoutResult = new Promise<ServiceLifecycleRunResult>((resolve) => {
      timeout = setTimeout(() => resolve({ code: null, timedOut: true, output: '' }), input.timeoutMs);
    });
    const result = await Promise.race([runnerPromise, timeoutResult]);
    if (result.timedOut && !runnerSettled) {
      Object.defineProperty(result, LIFECYCLE_RUN_SETTLEMENT, {
        value: settlement,
        enumerable: false,
      });
    }
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function getLifecycleRunSettlement(result: ServiceLifecycleRunResult): Promise<unknown> | undefined {
  return (result as ServiceLifecycleRunResult & { [LIFECYCLE_RUN_SETTLEMENT]?: Promise<unknown> })[
    LIFECYCLE_RUN_SETTLEMENT
  ];
}

export function lifecycleFailureStatus(error: string): number {
  if (error.includes('timed out')) return 408;
  if (error.includes('not found')) return 400;
  if (error.includes('runner failed')) return 502;
  return 422;
}
