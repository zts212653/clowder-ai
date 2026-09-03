import type { AgentCarrierSession, AgentCarrierSessionOptions } from '../../types.js';
import type { CodexAppServerHostPool } from './CodexAppServerHostPool.js';

type ReusableOptions = Omit<AgentCarrierSessionOptions, 'invocationId' | 'signal' | 'sessionId'>;

const MAX_CONTROL_SESSIONS_PER_POOL = 256;
const optionsByPool = new WeakMap<CodexAppServerHostPool, Map<string, ReusableOptions>>();

export function rememberCodexAppServerControlOptions(
  pool: CodexAppServerHostPool,
  sessionId: string,
  options: AgentCarrierSessionOptions,
): void {
  let bySession = optionsByPool.get(pool);
  if (!bySession) {
    bySession = new Map();
    optionsByPool.set(pool, bySession);
  }
  const { invocationId: _invocationId, signal: _signal, sessionId: _sessionId, ...reusable } = options;
  bySession.delete(sessionId);
  bySession.set(sessionId, reusable);
  while (bySession.size > MAX_CONTROL_SESSIONS_PER_POOL) {
    const oldest = bySession.keys().next().value;
    if (oldest === undefined) break;
    bySession.delete(oldest);
  }
}

export function resolveCodexAppServerControlOptions(
  pool: CodexAppServerHostPool,
  sessionId: string,
  invocationId: string,
): AgentCarrierSessionOptions | null {
  const bySession = optionsByPool.get(pool);
  const reusable = bySession?.get(sessionId);
  if (reusable && bySession) {
    bySession.delete(sessionId);
    bySession.set(sessionId, reusable);
  }
  return reusable ? { ...reusable, sessionId, invocationId } : null;
}

export function bindCodexAppServerControlOptions(
  pool: CodexAppServerHostPool,
  wire: AgentCarrierSession,
  options: AgentCarrierSessionOptions,
): AgentCarrierSession {
  if (options.sessionId) rememberCodexAppServerControlOptions(pool, options.sessionId, options);
  const rememberSession = wire.rememberSession?.bind(wire);
  wire.rememberSession = (sessionId) => {
    rememberCodexAppServerControlOptions(pool, sessionId, options);
    rememberSession?.(sessionId);
  };
  return wire;
}
