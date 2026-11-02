/** Internal / unstable session contract (#1647). */
import type { ProviderOutputMessage } from '@cat-cafe/shared';
import type * as Service from '../../types.js';
export type Support = 'supported' | 'unsupported';
export interface McpServerDescriptor {
  name: string;
  [k: string]: unknown;
}

export type HostSessionId = string;

export type HostInvocationId = string;

export interface AgentSessionCapabilities {
  input: Support;
  inputReadReceipt: Support;
  inspectInput: Support;
  cancelTurn: Support;
  compact: Support;
  observesCompaction: boolean;

  continuityEvidence: 'pre_send' | 'none';
}

export interface AgentSessionProvider {
  openSession(input: OpenSessionInput, signal: AbortSignal): Promise<OpenSessionResult>;
  startTurn(sessionId: HostSessionId, input: TurnInput, signal: AbortSignal): Promise<StartTurnResult>;
  input(sessionId: HostSessionId, expected: TurnRef, message: SupplementInput): Promise<InputResult>;
  inspectInput?(
    sessionId: HostSessionId,
    expected: TurnRef,
    deliveryId: string,
  ): Promise<'accepted' | 'not_accepted' | 'unknown'>;
  cancelTurn(sessionId: HostSessionId, expected: TurnRef, reason: string): Promise<CancelResult>;
  compact?(sessionId: HostSessionId, opts: CompactOptions): Promise<CompactResult>;
  release(
    sessionId: HostSessionId,
    reason: string,
  ): Promise<{ ok: true } | { ok: false; code: 'failed'; reason: string }>;
  capabilities(sessionId: HostSessionId): AgentSessionCapabilities;
}

export interface OpenSessionInput {
  sessionId: HostSessionId;
  resume?: { nativeSessionId: string; onUnavailable: 'fail' | 'start_new' };
  instructions: string;
  model?: string;
  config?: Record<string, unknown>;
  cwd: string;
}

export type OpenSessionResult =
  | { ok: true; binding: NativeBinding }
  | { ok: false; code: 'resume_unavailable' | 'failed'; reason: string };

export type NativeBinding = { state: 'bound'; nativeSessionId: string } | { state: 'pending_first_input' };

export interface TurnRef {
  invocationId: HostInvocationId;
  nativeTurnId?: string;
}

export interface TurnInput {
  /** Host-owned only: never serialize or expose to plugin code. */
  hostOptions?: Service.AgentServiceOptions;
  invocation: {
    invocationId: HostInvocationId;

    callbackEnv: Record<string, string>;

    mcpServers: McpServerDescriptor[];
    toolExecutionPolicy?: Service.ToolExecutionPolicy;
    requiredTools?: readonly string[];
  };
  prompt: PromptSource;
  deliveryId?: string;
  images?: readonly string[];
}

export type PromptSource =
  | { kind: 'frozen'; text: string }
  | { kind: 'deferred'; settle: Service.ProviderContinuityPreflight['settle'] };

export type PreSendFacts = Parameters<Service.ProviderContinuityPreflight['settle']>[0];

export type StartTurnResult =
  | { ok: true; turn: TurnRef; events: AsyncIterable<AgentSessionEvent> }
  | { ok: false; code: 'busy' | 'session_unavailable' | 'failed'; reason?: string };

export interface SupplementInput {
  text: string;
  images?: readonly string[];
  messageIds: readonly string[];

  deliveryId: string;
}

export type InputResult =
  | { status: 'accepted' }
  | { status: 'unsupported' }
  | { status: 'rejected'; reason: 'invalid_input' | 'provider_rejected' }
  | { status: 'turn_ended' }
  | { status: 'unknown' };

export type CancelResult = { ok: true } | { ok: false; code: 'unsupported' | 'turn_ended' | 'failed' };

export interface CompactOptions {
  invocationId: HostInvocationId;
  timeoutMs: number;
  signal: AbortSignal;

  onObserved?: (o: Service.ProviderCompactionObservation) => Promise<void>;
}

export type CompactResult =
  | { status: 'completed'; observation: Service.ProviderCompactionObservation }
  | { status: 'accepted' }
  | { status: 'unsupported' }
  | { status: 'busy' }
  | { status: 'session_unavailable' }
  | { status: 'failed'; reason: string; observed?: Service.ProviderCompactionObservation };

export type SessionEvent = { scope: 'session'; sessionId: HostSessionId; seq: number; nativeTurnRef?: string } & (
  | {
      type: 'native_bound';
      nativeSessionId: string;
      nativeSessionBinding?: Service.AgentMessage['nativeSessionBinding'];
      ephemeralSession?: boolean;
    }
  | { type: 'continuity'; evidence: Service.ProviderContinuityEvidence }
  | { type: 'compaction_observed'; observation: Service.ProviderCompactionObservation }
  | { type: 'context'; usage?: Service.TokenUsage; windowTokens?: number; model?: string }
);

export type TurnEvent = { scope: 'turn'; sessionId: HostSessionId; turn: TurnRef; seq: number } & (
  | {
      type: 'output';
      text: string;

      textMode: 'append' | 'replace';

      message?: Omit<ProviderOutputMessage, 'provider' | 'runtimeSessionId' | 'turnId' | 'channel'> & {
        channel?: 'final' | 'commentary' | 'unknown';
      };
    }
  | {
      type: 'tool_call';
      callId?: string;
      name?: string;
      input?: unknown;
      source?: Service.AgentMessage['toolSource'];
      rawPayload?: Service.AgentMessage['toolRawPayload'];
    }
  | {
      type: 'tool_result';
      callId?: string;
      name?: string;
      status: 'ok' | 'error' | 'unknown';
      output?: unknown;
      input?: unknown;
      source?: Service.AgentMessage['toolSource'];
      rawPayload?: Service.AgentMessage['toolRawPayload'];
    }
  | { type: 'status'; phase?: string; detail?: string }
  | { type: 'system_info' | 'provider_signal' | 'liveness_signal' | 'agent_loop'; content?: string }
  | {
      type: 'handoff';
      content?: string;
      targetCatId?: Service.AgentMessage['targetCatId'];
      routing?: Service.AgentMessage['routing'];
    }
  | { type: 'input_read'; deliveryId: string }
  | { type: 'error'; code: string; message: string; disposition: 'transient' | 'terminal' }
  | { type: 'done'; outcome: 'completed' | 'cancelled' | 'failed'; errorCode?: string }
);

export type AgentSessionEvent = (SessionEvent | TurnEvent) & {
  /** Usage belongs to this emitted message, never to the cached session context. */
  messageUsage?: Service.TokenUsage;
};
