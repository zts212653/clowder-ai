import {
  type ForceReleaseOptions,
  type ForceReleaseResult,
  type SessionLockScope,
  SessionMutex,
} from './SessionMutex.js';

/** Narrow lifecycle surface shared by invocation, REST, and WebSocket adapters. */
export interface AgentSessionMutexLike {
  forceReleaseByScope(scope: SessionLockScope, options?: ForceReleaseOptions): ForceReleaseResult;
}

/**
 * Process-wide owner-aware lock for resumable agent sessions.
 *
 * Keeping this singleton in its own module makes terminal adapters able to
 * release the same lock acquired by invokeSingleCat. Legacy SessionMutex users
 * (for example profile updates) remain isolated.
 */
export const agentSessionMutex = new SessionMutex();
