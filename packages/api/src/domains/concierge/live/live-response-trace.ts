import type { ProviderSubexecutionSemanticEvent } from '@cat-cafe/shared';
import { type Attributes, type Span, trace } from '@opentelemetry/api';
import type { CodexAppServerJsonObject } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type {
  HostTextSubmission,
  HostVoiceObservation,
} from '../../plugin/desktop-window-runtime/companion-private-wire.js';
import { record } from './live-call-async.js';

export type LiveResponseStage =
  | 'client_text_sent'
  | 'typed_received'
  | 'persistent_accept'
  | 'native_accepted'
  | 'host_acquired'
  | 'native_ready'
  | 'provider_ready'
  | 'provider_text_delta'
  | 'first_outward_text'
  | 'owner_voice_completed'
  | 'first_audio_output'
  | 'child_started'
  | 'child_first_output'
  | 'child_terminal'
  | 'child_tool_failed'
  | 'result_committed'
  | 'speech_submitted'
  | 'first_text_visible';
type Evidence = {
  messageId?: string;
  clientMessageId?: string;
  nativeTurnId?: string;
  nativeItemId?: string;
  realtimeTurnId?: string;
  sourceRefs?: readonly string[];
  hostMode?: 'cold' | 'warm';
  childId?: string;
};

/** F153 timing observations, never a second conversation history or a claim that a response was useful. */
export class LiveResponseTrace {
  private closed = false;
  private count = 0;
  private readonly first = new Set<string>();
  private readonly receipts = new Set<string>();
  private readonly span: Pick<Span, 'addEvent' | 'end'>;
  private readonly createSpan: (attributes: Attributes) => Pick<Span, 'addEvent' | 'end'>;
  constructor(
    private readonly scope: { userId: string; threadId: string; catId: string; callId: string },
    factory: (attributes: Attributes) => Pick<Span, 'addEvent' | 'end'> = (attributes) =>
      trace
        .getTracer('cat-cafe-api', '0.1.0')
        .startSpan(attributes['live.stage'] ? 'cat_cafe.live_response.observation' : 'cat_cafe.live_response', {
          attributes,
          ...(typeof attributes['live.observed_at'] === 'number'
            ? { startTime: new Date(attributes['live.observed_at']) }
            : {}),
        }),
  ) {
    this.createSpan = factory;
    this.span = factory({
      ...scope,
      'live.initial_text_visible': 'unobserved',
      'live.system_audible': 'unobserved',
      'live.usefulness': 'requires_original_content',
      'live.initial_client_text_sent': 'unobserved',
    });
  }
  mark(stage: LiveResponseStage, evidence: Evidence = {}, observedAt = Date.now()): void {
    if (this.closed || this.count >= 5000 || !Number.isSafeInteger(observedAt) || observedAt < 0) return;
    this.count++;
    // Finish each point immediately: a long call must not defer export or exhaust the SDK's per-span event cap.
    const observation = this.createSpan({
      ...this.scope,
      'agent.id': this.scope.catId,
      'live.stage': stage,
      'live.observed_at': observedAt,
      'live.clock_domain': 'unix_epoch_ms',
    });
    observation.addEvent(
      `live.${stage}`,
      {
        ...(Object.fromEntries(
          Object.entries(evidence)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, Array.isArray(value) ? [...value].slice(0, 32) : value]),
        ) as Attributes),
        'live.request_association': evidence.sourceRefs?.length ? 'acknowledged_context_refs' : 'unknown',
      },
      new Date(observedAt),
    );
    observation.end(new Date(observedAt));
  }
  protocol(envelope: CodexAppServerJsonObject, realtimeSessionId?: string): void {
    const params = record(envelope.params);
    if (envelope.method === 'thread/realtime/started') this.mark('provider_ready');
    const deep = envelope.method === 'item/agentMessage/delta';
    const voice = envelope.method === 'thread/realtime/transcript/delta' && params.role === 'assistant';
    if (voice && (!realtimeSessionId || (params.realtimeSessionId && params.realtimeSessionId !== realtimeSessionId)))
      return;
    if ((!deep && !voice) || typeof params.delta !== 'string' || !params.delta.trim()) return;
    const turn = typeof params.turnId === 'string' ? params.turnId : undefined;
    const item = typeof params.itemId === 'string' ? params.itemId : undefined;
    // Missing protocol coordinates remain call-level observations; never attribute them to the latest question.
    const key = `${deep ? 'deep' : 'voice'}:${turn ?? 'unknown'}:${item ?? 'unknown'}`;
    if (this.first.has(key)) return;
    this.first.add(key);
    this.mark('provider_text_delta', {
      ...(turn ? { nativeTurnId: turn } : {}),
      ...(item ? { nativeItemId: item } : {}),
    });
  }
  playback(receipt: HostVoiceObservation): void {
    if (
      receipt.callId !== this.scope.callId ||
      this.receipts.has(receipt.eventId) ||
      Math.abs(Date.now() - receipt.observedAt) > 5000 ||
      this.receipts.size >= 4096
    )
      return;
    this.receipts.add(receipt.eventId);
    const key = `host:${receipt.stage}:${receipt.stage === 'first_outward_text' ? receipt.nativeItemId : receipt.turnId}`;
    if (this.first.has(key)) return;
    this.first.add(key);
    this.mark(
      receipt.stage,
      {
        realtimeTurnId: receipt.turnId,
        ...(receipt.stage === 'first_outward_text' ? { nativeItemId: receipt.nativeItemId } : {}),
      },
      receipt.observedAt,
    );
  }
  textSubmission(receipt: HostTextSubmission): void {
    if (this.closed || Math.abs(Date.now() - receipt.observedAt) > 5000) return;
    const key = `input:${receipt.clientMessageId}`;
    if (this.first.has(key)) return;
    this.first.add(key);
    this.mark('client_text_sent', { clientMessageId: receipt.clientMessageId }, receipt.observedAt);
  }
  child(event: ProviderSubexecutionSemanticEvent, messageId: string): void {
    const evidence = { messageId, nativeTurnId: event.turnId, childId: event.subexecutionId };
    if (event.stage !== 'message') {
      this.mark(event.stage === 'started' ? 'child_started' : 'child_terminal', evidence, event.occurredAt);
      return;
    }
    if (event.id.startsWith('subexecution:codex:tool-failed:')) {
      this.mark('child_tool_failed', evidence, event.occurredAt);
      return;
    }
    if (!['commentary', 'final_answer'].includes(event.messagePhase ?? '') || !event.content?.trim()) return;
    const key = `child:${event.subexecutionId}:${event.turnId ?? 'unknown'}`;
    if (this.first.has(key)) return;
    this.first.add(key);
    this.mark('child_first_output', evidence, event.occurredAt);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.span.end();
    this.first.clear();
    this.receipts.clear();
  }
}
