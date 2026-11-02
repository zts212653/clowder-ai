import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, MessageMetadata } from '../../../types.js';
import { AgyStepEvidence } from '../agy-step-evidence.js';
import type { AgyStreamJsonEvent } from '../agy-stream-json-parser.js';
import { agyNativeToolIdentity, agyNativeToolResultContent } from './agy-native-tool-result.js';

/** Incremental presentation only. Terminal authority stays with the completed turn. */
export class AgyNativeProgress {
  private readonly evidence = new AgyStepEvidence();
  private readonly started = new Map<string, { nativeName: string; emitted: boolean }>();
  private readonly finished = new Set<string>();
  private readonly parameters = new Map<number, Record<string, unknown>>();
  private readonly errors = new Map<number, string>();
  private readonly checkpoints = new Set<number>();
  private text = '';

  constructor(
    private readonly catId: CatId,
    private readonly metadata: MessageMetadata,
  ) {}

  step(observed: Extract<AgyStreamJsonEvent, { kind: 'step' }>): AgentMessage[] {
    const event = this.evidence.observe(observed);
    if (event.anomalies.length && !this.errors.has(event.stepIndex))
      this.errors.set(
        event.stepIndex,
        `Native tool result unconfirmed: ${event.anomalies.map((a) => a.detail).join('; ')}`,
      );
    const messages: AgentMessage[] = [];
    if (
      event.stepType === 'checkpoint' &&
      event.state === 'DONE' &&
      event.conversationId === this.metadata.sessionId &&
      event.stepIndex >= 0 &&
      !this.checkpoints.has(event.stepIndex)
    ) {
      this.checkpoints.add(event.stepIndex);
      messages.push({
        type: 'status',
        catId: this.catId,
        content: 'thinking',
        metadata: this.metadata,
        timestamp: Date.now(),
        contextCompaction: {
          eventSource: 'agy_native_checkpoint',
          event: {
            eventId: `agy-native:${event.conversationId}:checkpoint:${event.stepIndex}`,
            runtimeSessionId: event.conversationId,
            evidenceRef: `agy_native_checkpoint:${event.conversationId}:${event.stepIndex}`,
          },
        },
      });
    }
    if (event.textDelta) {
      this.text += event.textDelta;
      messages.push({
        type: 'text',
        catId: this.catId,
        content: event.textDelta,
        metadata: this.metadata,
        timestamp: Date.now(),
      });
    }
    if (event.stepType !== 'tool' || !event.toolName) return messages;
    const toolUseId = `${this.metadata.sessionId}:${event.stepIndex}`;
    let started = this.started.get(toolUseId);
    if (!started) {
      started = { nativeName: event.toolName, emitted: false };
      this.started.set(toolUseId, started);
    }
    const startedToolName = started.nativeName;
    // A live tool ID belongs to its first native tool, including before terminal validation.
    const identityChanged = startedToolName !== event.toolName;
    if (!identityChanged) {
      if (event.toolParameters) this.parameters.set(event.stepIndex, event.toolParameters);
      if (event.toolErrorMessage) this.errors.set(event.stepIndex, event.toolErrorMessage);
    }
    const identity = agyNativeToolIdentity(startedToolName, this.parameters.get(event.stepIndex) ?? {});
    if (event.toolName === 'call_mcp_tool' && identity.toolName === 'call_mcp_tool' && event.state === 'ACTIVE') {
      return messages;
    }
    const common = {
      catId: this.catId,
      toolName: identity.toolName,
      toolUseId,
      toolSource: identity.toolSource,
      metadata: this.metadata,
      timestamp: Date.now(),
    };
    if (!started.emitted) {
      started.emitted = true;
      messages.push({ ...common, type: 'tool_use', toolInput: identity.toolInput });
    }
    if (
      !this.finished.has(common.toolUseId) &&
      (identityChanged || event.state === 'DONE' || event.state === 'ERROR')
    ) {
      this.finished.add(common.toolUseId);
      const error = identityChanged
        ? [
            this.errors.get(event.stepIndex),
            `Native tool result unconfirmed: tool identity changed from ${startedToolName} to ${event.toolName}.`,
          ]
            .filter(Boolean)
            .join('\n\n')
        : (this.errors.get(event.stepIndex) ?? null);
      messages.push({
        ...common,
        type: 'tool_result',
        content: agyNativeToolResultContent(identityChanged ? null : event.toolOutput, error),
        toolResultStatus: event.state === 'DONE' && error === null ? 'ok' : 'error',
      });
    }
    return messages;
  }

  final(messages: readonly AgentMessage[]): AgentMessage[] {
    return messages.flatMap((message) => {
      if (message.type === 'session_init' || message.type === 'tool_use') return [];
      if (message.type === 'tool_result') {
        const id = message.toolUseId;
        if (!id || !this.started.get(id)?.emitted || this.finished.has(id)) return [];
        this.finished.add(id);
        return [message];
      }
      if (message.type !== 'text' || !this.text) return [message];
      // result.response is a snapshot, not another delta. A corrected snapshot
      // replaces partial output; a matching snapshot must never duplicate it.
      return message.content === this.text ? [] : [{ ...message, textMode: 'replace' as const }];
    });
  }
}
