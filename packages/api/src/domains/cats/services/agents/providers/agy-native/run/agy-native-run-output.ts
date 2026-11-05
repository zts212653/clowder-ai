import type { CatId } from '@cat-cafe/shared';
import type { AgentMessage, MessageMetadata } from '../../../../types.js';
import type { AgyStreamJsonEvent } from '../../agy-stream-json-parser.js';
import { AgyNativeProgress } from '../agy-native-progress.js';
import { type AgyNativeObservedTurn, projectAgyNativeTurn } from '../agy-native-turn.js';

/** Per-turn presentation, invocation-wide accounting and one final terminal. */
export class AgyNativeRunOutput {
  private turnMetadata: MessageMetadata;
  private progress: AgyNativeProgress;
  private completedText = '';
  private resultSeen = false;
  private lastMetadata: MessageMetadata | undefined;
  private usage: MessageMetadata['usage'];
  successful = false;

  constructor(
    private readonly catId: CatId,
    private readonly metadata: MessageMetadata,
    private readonly tools: readonly string[],
  ) {
    this.turnMetadata = { ...metadata };
    this.progress = new AgyNativeProgress(catId, this.turnMetadata);
  }

  step(event: Extract<AgyStreamJsonEvent, { kind: 'step' }>): AgentMessage[] {
    this.resultSeen = false;
    return this.progress.step(event);
  }

  result(observed: AgyNativeObservedTurn): AgentMessage[] {
    const messages = projectAgyNativeTurn(
      this.catId,
      this.turnMetadata,
      observed,
      observed.cancelledBeforeTerminal === true,
      this.tools,
    );
    this.successful = messages.at(-1)?.type === 'done' && messages.at(-1)?.errorCode === undefined;
    const projected = this.progress
      .final(messages)
      .filter((m) => m.type !== 'done' && m.type !== 'error')
      .map((m) =>
        m.type === 'text' && m.textMode === 'replace' ? { ...m, content: this.completedText + m.content } : m,
      );
    this.accountUsage(this.turnMetadata);
    this.lastMetadata = this.turnMetadata;
    this.completedText += observed.turn.finalText;
    this.resultSeen = true;
    this.turnMetadata = { ...this.metadata, usage: undefined };
    this.progress = new AgyNativeProgress(this.catId, this.turnMetadata);
    return projected;
  }

  finish(observed: AgyNativeObservedTurn): AgentMessage[] {
    const terminalMetadata = { ...(this.resultSeen && this.lastMetadata ? this.lastMetadata : this.turnMetadata) };
    const messages = projectAgyNativeTurn(
      this.catId,
      terminalMetadata,
      observed,
      observed.cancelledBeforeTerminal === true,
      this.tools,
    );
    if (!this.resultSeen) this.accountUsage(terminalMetadata);
    const final = this.resultSeen
      ? messages.filter((m) => m.type === 'error' || m.type === 'done')
      : this.progress.final(messages);
    return final.map((message) => ({
      ...message,
      metadata: { ...terminalMetadata, ...(this.usage ? { usage: this.usage } : {}) },
    }));
  }

  private accountUsage(metadata: MessageMetadata): void {
    const current = metadata.usage;
    if (!current) return;
    this.usage = {
      inputTokens: (this.usage?.inputTokens ?? 0) + (current.inputTokens ?? 0),
      outputTokens: (this.usage?.outputTokens ?? 0) + (current.outputTokens ?? 0),
      totalTokens: (this.usage?.totalTokens ?? 0) + (current.totalTokens ?? 0),
      cacheReadTokens: (this.usage?.cacheReadTokens ?? 0) + (current.cacheReadTokens ?? 0),
      ...(current.lastTurnInputTokens !== undefined ? { lastTurnInputTokens: current.lastTurnInputTokens } : {}),
    };
  }
}
