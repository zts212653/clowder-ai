import { piErrorExcerpt } from './pi-rpc-diagnostics.js';
import { type PiRecord, record } from './pi-rpc-process.js';

/** Translates progress only. Neither prompt admission nor agent_end is a terminal success fence. */
export class PiAcpEvents {
  private streamedText = '';
  private streamedThinking = '';
  private textChars = 0;
  private thoughtChars = 0;
  private toolEvents = 0;
  private assistantEnds = 0;
  failure?: Error;
  completedAssistant = false;
  constructor(private readonly update: (value: PiRecord) => void) {}

  accept(event: PiRecord): void {
    const message = record(event.message);
    if (event.type === 'message_start' && message.role === 'assistant') {
      this.streamedText = this.streamedThinking = '';
      this.failure = undefined;
      this.completedAssistant = false;
    }
    if (event.type === 'message_update') this.delta(record(event.assistantMessageEvent));
    if (event.type === 'message_end' && message.role === 'assistant') this.final(message);
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
      this.toolEvents++;
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
    // Ported from #14's guard; whitespace is tracked separately from usable output.
    if (typeof delta.delta !== 'string' || delta.delta === '') return;
    if (delta.type === 'text_delta') {
      this.streamedText += delta.delta;
      this.chunk('agent_message_chunk', delta.delta);
    } else if (delta.type === 'thinking_delta') {
      this.streamedThinking += delta.delta;
      this.chunk('agent_thought_chunk', delta.delta);
    }
  }

  private final(message: PiRecord): void {
    this.completedAssistant = true;
    this.assistantEnds++;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      const detail =
        typeof message.errorMessage === 'string' ? piErrorExcerpt(message.errorMessage) : 'Provider request failed';
      this.failure = new Error(`Pi: ${detail}`);
      return;
    }
    const blocks = (Array.isArray(message.content) ? message.content : []).map(record);
    const text = blocks.map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
    const thinking = blocks
      .map((b) => (b.type === 'thinking' && typeof b.thinking === 'string' ? b.thinking : ''))
      .join('');
    this.finalChunk('agent_message_chunk', text, this.streamedText);
    this.finalChunk('agent_thought_chunk', thinking, this.streamedThinking);
  }

  private finalChunk(type: string, final: string, streamed: string): void {
    if (!final) return;
    if (final.startsWith(streamed)) this.chunk(type, final.slice(streamed.length));
    else if (!streamed.trim()) this.chunk(type, final);
    else this.failure = new Error('Pi final content does not match its streamed response');
  }

  summary(): PiRecord {
    return {
      assistantEnds: this.assistantEnds,
      textChars: this.textChars,
      thoughtChars: this.thoughtChars,
      toolEvents: this.toolEvents,
    };
  }

  private chunk(sessionUpdate: string, text: string): void {
    if (!text) return;
    if (sessionUpdate === 'agent_message_chunk') this.textChars += text.trim().length;
    else this.thoughtChars += text.length;
    this.update({ sessionUpdate, content: { type: 'text', text } });
  }
}
