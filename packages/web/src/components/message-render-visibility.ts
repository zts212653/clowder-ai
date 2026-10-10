import type { ChatMessage } from '@/stores/chat-types';
import { computeCliDiagnosticsDedup } from '@/utils/cli-diagnostics-dedup';
import { doesAssistantMessageRenderBubble } from './assistant-message-renderability';
import { isKnownReason } from './CliDiagnosticsPanel';
import { isLinkedCloudBindingRecoveryNotice } from './cloud-binding-recovery';

/**
 * F322 B segment 1 (human message) — does this row put anything on screen?
 *
 * A run of your own messages is read from what is on screen, so the grouping has to know which rows `ChatMessage` really
 * draws. This mirrors `ChatMessage`'s early exits in the order it takes them, using the very helpers it uses (the assistant
 * renderability contract, the linked cloud notice, the folded-source anchor, the CLI-diagnostics duplicate collapse) so
 * there is no second opinion. `message-render-visibility.test.tsx` renders a spread of rows through the real `ChatMessage`
 * and fails on any disagreement: a new early exit there that is not here is a named mismatch, not a silent drift.
 */

export function isConnectorSystemNotice(message: ChatMessage): boolean {
  if (message.type !== 'connector' || !message.source?.meta) return false;
  return (message.source.meta as Record<string, unknown>).presentation === 'system_notice';
}

interface VisibilityContext {
  /** The thread the row is drawn in (a cross-thread source is judged against it). */
  currentThreadId?: string;
}

/** The real system renderer keeps a zero-height anchor for duplicate CLI diagnostics. */
function isCollapsedDiagnosticsDuplicate(message: ChatMessage, timeline: readonly ChatMessage[]): boolean {
  return computeCliDiagnosticsDedup(timeline).get(message.id)?.hideDiagnosticsPanel === true;
}

/** `true` when `ChatMessage` draws nothing visible for this row (a null, or a zero-height aria-hidden anchor). */
export function messageRendersNothing(
  message: ChatMessage,
  timeline: readonly ChatMessage[],
  context: VisibilityContext = {},
): boolean {
  const isOwn = message.from?.kind === 'user';

  // The first thing ChatMessage does: a summary with its content is a card (without it, the row falls through to nothing).
  if (message.type === 'summary' && message.summary) return false;

  if (message.type === 'system') {
    // The first branches draw something whatever else the message carries.
    if (message.origin === 'briefing' && message.extra?.rich?.blocks?.length) return false;
    if (message.variant === 'evidence' && message.evidence) return false;
    if (message.variant === 'governance_blocked' && message.extra?.governanceBlocked) return false;
    const diagnostics = message.extra?.cliDiagnostics;
    const isError = message.variant === 'error' || (!message.variant && message.content.trim().startsWith('Error:'));
    if (!isError && !diagnostics) return false;
    // A classified CLI error, then the timeout panel, then an unclassified CLI error: only the two CLI ones can collapse.
    if (isKnownReason(diagnostics?.reasonCode)) return isCollapsedDiagnosticsDuplicate(message, timeline);
    if (isError && message.extra?.timeoutDiagnostics) return false;
    if (diagnostics) return isCollapsedDiagnosticsDuplicate(message, timeline);
    return false;
  }

  if (message.from?.kind === 'external' || message.from?.kind === 'plugin' || message.type === 'connector') {
    return isConnectorSystemNotice(message) && isLinkedCloudBindingRecoveryNotice(message, timeline);
  }

  if (isOwn) {
    return message.extra?.recall?.exposure === 'none';
  }

  // Everything else goes through the assistant bubble: a connector with no source, or any other record, is not
  // assistant-authored and draws nothing there.
  return !doesAssistantMessageRenderBubble(message, { currentThreadId: context.currentThreadId });
}
