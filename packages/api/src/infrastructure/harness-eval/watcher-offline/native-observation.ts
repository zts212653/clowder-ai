import type { AgentMessage } from '../../../domains/cats/services/types.js';
import { sanitizeCliStderr } from '../../../utils/sanitize-cli-stderr.js';
import type { WatcherCall } from './run-case.js';
import { hasObservedTokens, type OfflineUsage, readOfflineUsage, record } from './usage.js';
import { decodeWatcherWire } from './wire-schema.js';

/** Observe only public model/output/tool metadata. Never retain reasoning or native trace lines. */
export class NativeWatcherObservation {
  private readonly call: WatcherCall;
  private readonly usage: OfflineUsage[] = [];
  private nativeText = '';
  private terminal = false;
  private failed = false;

  constructor(
    private readonly provider: OfflineUsage['provider'],
    model: string,
    private readonly cancel: () => void,
  ) {
    this.call = {
      success: false,
      text: '',
      elapsedMs: 0,
      requestedModel: model,
      servedModel: null,
      usage: [],
      nativeToolSurface: provider === 'openai' ? 'restricted_launch' : undefined,
    };
  }

  observe(value: unknown): void {
    const event = record(value);
    const usage = readOfflineUsage(this.provider, event);
    if (usage) this.usage.push(usage);
    if (this.provider === 'anthropic') this.observeClaude(event);
    else this.observeCodex(event);
    if (Buffer.byteLength(this.nativeText) > 8000) this.cancel();
  }

  observeMessage(message: Pick<AgentMessage, 'type' | 'metadata' | 'error' | 'errorCode' | 'errorDisposition'>): void {
    if (message.metadata?.servedModel) this.call.servedModel = message.metadata.servedModel;
    if (message.type === 'error') {
      if (message.errorDisposition !== 'transient') this.failed = true;
      const diagnostic = message.metadata?.cliDiagnostics;
      (this.call.diagnostics ??= []).push({
        code: message.errorCode,
        publicSummary:
          diagnostic?.publicSummary ?? (message.error ? sanitizeCliStderr(message.error).slice(0, 1000) : undefined),
        safeExcerpt: diagnostic?.safeExcerpt,
        debugRef: diagnostic?.debugRef,
      });
    }
    if (message.type === 'done') {
      this.terminal = true;
      this.failed ||= Boolean(message.errorCode);
    }
  }

  finish(elapsedMs: number, aborted: boolean): WatcherCall {
    const call = { ...this.call, elapsedMs, usage: [...this.usage], nativeText: this.nativeText };
    const error = this.failureReason(aborted);
    if (error) return { ...call, error };
    try {
      return { ...call, text: JSON.stringify(decodeWatcherWire(JSON.parse(this.nativeText))), success: true };
    } catch {
      return { ...call, error: 'native_output_invalid' };
    }
  }

  private failureReason(aborted: boolean): string | undefined {
    if (this.call.nativeToolSurface === 'unexpected') return 'unexpected_native_tool';
    if (aborted) return 'native_call_cancelled_or_timeout';
    if (!this.terminal || this.failed) return 'native_call_incomplete';
    if (!this.call.nativeToolSurface) return 'native_surface_unverified';
    if (!this.call.servedModel) return 'native_model_unobserved';
    if (this.call.servedModel !== this.call.requestedModel) return 'native_model_mismatch';
    if (!this.usage.length || this.usage.some((usage) => !hasObservedTokens(usage))) return 'native_usage_unobserved';
    return undefined;
  }

  private rejectSurface(): void {
    this.call.nativeToolSurface = 'unexpected';
    this.cancel();
  }

  private observeCodex(event: Record<string, unknown>): void {
    const item = record(event.item);
    if (typeof item.type === 'string' && !['agent_message', 'reasoning', 'todo_list', 'error'].includes(item.type)) {
      this.rejectSurface();
    }
    if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
      this.nativeText = item.text;
    }
  }

  private observeClaude(event: Record<string, unknown>): void {
    if (event.type === 'system' && event.subtype === 'init') this.observeClaudeInit(event);
    if (event.type === 'stream_event') {
      const stream = record(event.event);
      if (stream.type === 'message_start') this.observeClaudeMessage(record(stream.message));
      if (stream.type === 'content_block_start') this.observeClaudeBlock(stream.content_block);
    }
    if (event.type === 'assistant') this.observeClaudeMessage(record(event.message));
    if (event.type === 'result') {
      this.nativeText = event.structured_output
        ? JSON.stringify(event.structured_output)
        : typeof event.result === 'string'
          ? event.result
          : '';
    }
  }

  private observeClaudeInit(event: Record<string, unknown>): void {
    this.call.nativeTools = Array.isArray(event.tools)
      ? event.tools.filter((tool): tool is string => typeof tool === 'string')
      : undefined;
    this.call.nativeMcpServers = Array.isArray(event.mcp_servers)
      ? event.mcp_servers.map((server) => String(record(server).name ?? 'unknown'))
      : undefined;
    if (
      !Array.isArray(event.tools) ||
      event.tools.some((tool) => tool !== 'StructuredOutput') ||
      !Array.isArray(event.mcp_servers) ||
      event.mcp_servers.length
    )
      this.rejectSurface();
    else this.call.nativeToolSurface = event.tools.length ? 'output_only' : 'empty';
  }

  private observeClaudeMessage(message: Record<string, unknown>): void {
    if (typeof message.model === 'string') this.call.servedModel = message.model;
    if (Array.isArray(message.content)) for (const block of message.content) this.observeClaudeBlock(block);
  }

  private observeClaudeBlock(value: unknown): void {
    const block = record(value);
    if ((block.type === 'tool_use' && block.name !== 'StructuredOutput') || block.type === 'server_tool_use')
      this.rejectSurface();
  }
}
