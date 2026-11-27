import type { AgentAdapterDetection } from './adapter-declaration.js';

/** Already bound to the admitted package, Host account, worktree and action. */
export interface AgentAdapterNativeRuntime {
  inspect?(signal: AbortSignal): Promise<AgentAdapterDetection['candidates'][number]['state']>;
  prepare?(
    input: { hostSessionId: string; resumeNativeSessionId?: string; instructions: string },
    signal: AbortSignal,
  ): Promise<{ agentFile?: string; nativeSessionId?: string; sessionFingerprint?: string }>;
  recordSessionFingerprint?(
    input: { hostSessionId: string; nativeSessionId: string; fingerprint: string },
    signal: AbortSignal,
  ): Promise<void>;
  run?(
    input: { hostSessionId: string; args: readonly string[]; stdin?: string },
    signal: AbortSignal,
  ): Promise<AsyncIterable<{ kind: 'record'; value: unknown } | { kind: 'exit'; code: number | null }>>;
  terminal?: {
    capture(input: { submit: string }, signal: AbortSignal): Promise<{ output: string; observedAt: number }>;
  };
}
