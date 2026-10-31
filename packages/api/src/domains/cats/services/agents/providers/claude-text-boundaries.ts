/** Invocation-local text identity, shared across background transcript tail batches. */
export interface ClaudeTextBoundaryState {
  lastTextMessageId?: string | undefined;
}

/** Preserve provider message boundaries without changing token/block concatenation. */
export function withClaudeMessageBoundary(
  text: string,
  messageId: string | undefined,
  state: ClaudeTextBoundaryState,
): string {
  const separate = Boolean(messageId && state.lastTextMessageId && messageId !== state.lastTextMessageId);
  // Unknown identity breaks continuity: do not infer boundaries for legacy id-less events.
  state.lastTextMessageId = messageId;
  return separate ? `\n\n${text}` : text;
}
