import { sanitizeCliStderr } from '../../../../../../utils/sanitize-cli-stderr.js';
import { type PiRecord, record } from './pi-rpc-process.js';

/** Translates progress only. Neither prompt admission nor agent_end is a terminal success fence. */
export class PiAcpEvents {
  private streamedText = false;
  private streamedThinking = false;
  failure?: Error;
  completedAssistant = false;
  constructor(private readonly update: (value: PiRecord) => void) {}

  accept(event: PiRecord): void {
    const message = record(event.message);
    if (event.type === 'message_start' && message.role === 'assistant') {
      this.streamedText = this.streamedThinking = false;
      this.failure = undefined;
      this.completedAssistant = false;
    }
    if (event.type === 'message_update') this.delta(record(event.assistantMessageEvent));
    if (event.type === 'message_end' && message.role === 'assistant') this.final(message);
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
      this.update({
        sessionUpdate: 'tool_call',
        toolCallId: event.toolCallId,
        title: typeof event.toolName === 'string' ? event.toolName : 'Pi tool',
        status: 'in_progress',
        rawInput: event.args,
      });
    }
    if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
      this.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: event.toolCallId,
        status: event.isError ? 'failed' : 'completed',
        rawOutput: event.result,
      });
    }
  }

  private delta(delta: PiRecord): void {
    if (typeof delta.delta !== 'string') return;
    if (delta.type === 'text_delta') {
      this.streamedText = true;
      this.chunk('agent_message_chunk', delta.delta);
    } else if (delta.type === 'thinking_delta') {
      this.streamedThinking = true;
      this.chunk('agent_thought_chunk', delta.delta);
    }
  }

  private final(message: PiRecord): void {
    this.completedAssistant = true;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      const detail =
        typeof message.errorMessage === 'string'
          ? sanitizeCliStderr(message.errorMessage).slice(0, 1_000)
          : 'Provider request failed';
      this.failure = new Error(`Pi: ${detail}`);
      return;
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      const content = record(block);
      if (content.type === 'text' && typeof content.text === 'string' && !this.streamedText)
        this.chunk('agent_message_chunk', content.text);
      if (content.type === 'thinking' && typeof content.thinking === 'string' && !this.streamedThinking)
        this.chunk('agent_thought_chunk', content.thinking);
    }
  }

  private chunk(sessionUpdate: string, text: string): void {
    this.update({ sessionUpdate, content: { type: 'text', text } });
  }
}
