import type { AcpSessionUpdate, AcpStopReason } from './acp.js';
import type { AgentAdapterDetection } from './adapter-declaration.js';

interface AgentAdapterAcpRuntime {
  open(
    input: {
      hostSessionId: string;
      resumeNativeSessionId?: string;
      startup: { moduleUrl: string; config: Readonly<Record<string, string>> };
    },
    signal: AbortSignal,
  ): Promise<{ ok: true; nativeSessionId: string } | { ok: false; code: 'resume_unavailable' | 'failed' }>;
  prompt(
    input: { hostSessionId: string; prompt: string },
    signal: AbortSignal,
  ): Promise<
    AsyncIterable<
      | { kind: 'update'; update: AcpSessionUpdate }
      | { kind: 'terminal'; stopReason: AcpStopReason; finalResponse: boolean }
    >
  >;
  cancel(hostSessionId: string): Promise<boolean>;
  release(hostSessionId: string): Promise<void>;
}

/** Already bound to the admitted package, Host account, worktree and action. */
export interface AgentAdapterNativeRuntime {
  acp?: AgentAdapterAcpRuntime;
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
