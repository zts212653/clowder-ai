import { formatVisibleSystemInfo } from '@/hooks/system-info-visible';
import type { ChatMessage, EvidenceData, RichBlock } from '@/stores/chat-types';
import { isLinkedDeliveryFailureCarrier } from './MessageDispatchAvatars';
import { selectTerminalDiagnostics, type TerminalDiagnostics } from './TerminalDiagnosticsPanel';

/**
 * Which surface a chat row renders, decided once. ChatMessage renders from these projections and
 * list-level projections (the adjacent-duplicate diagnostics dedup) read the same ones, so a list
 * can never reason about a panel the row does not show.
 */

const INTERNAL_PROTOCOL_DIAGNOSTIC_SERVICES = new Set(['routing-guard', 'a2a-liveness-guard']);

/**
 * Rows that are no user-facing surface at all. Phase C legacy routing projections stay readable
 * in History storage; F167 routing/liveness guards are internal protocol diagnostics. History/API
 * filters remain the primary boundary; this keeps persisted or stale client caches from flashing them.
 */
export function isHiddenChatRow(message: ChatMessage): boolean {
  if (message.extra?.systemKind === 'a2a_routing') return true;
  if (message.type === 'system') {
    // Rehydrate protocol metadata through the same explicit presentation contract as live events.
    if (message.extra?.providerRecovery) return true;
    if (
      message.extra?.systemInfo &&
      !message.extra.governanceBlocked &&
      !formatVisibleSystemInfo(message.extra.systemInfo.payload)
    )
      return true;
  }
  return message.from?.kind === 'system' && INTERNAL_PROTOCOL_DIAGNOSTIC_SERVICES.has(message.from.service);
}

type GovernanceBlocked = NonNullable<NonNullable<ChatMessage['extra']>['governanceBlocked']>;

/** What a system row renders, in precedence order. */
export type SystemRowSurface =
  /** A failure linked from a cat-authored source settles into that source's dispatch avatars. */
  | { kind: 'absorbed' }
  | { kind: 'briefing'; block: RichBlock }
  | { kind: 'evidence'; evidence: EvidenceData }
  | { kind: 'governance_blocked'; blocked: GovernanceBlocked }
  | { kind: 'diagnostics'; selected: TerminalDiagnostics }
  | { kind: 'notice'; isError: boolean };

export function projectSystemRowSurface(
  message: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): SystemRowSurface {
  // An unlinked origin failure is the canonical user-visible row, so only a linked one is absorbed.
  if (isLinkedDeliveryFailureCarrier(message, timelineMessages)) return { kind: 'absorbed' };
  // F148 ContextBriefing and F233 duty briefing are user-visible, collapsed cards.
  // F148 remains distinguishable via extra.systemKind='context_briefing'.
  const briefing = message.origin === 'briefing' ? message.extra?.rich?.blocks?.[0] : undefined;
  if (briefing) return { kind: 'briefing', block: briefing };
  if (message.variant === 'evidence' && message.evidence) return { kind: 'evidence', evidence: message.evidence };
  if (message.variant === 'governance_blocked' && message.extra?.governanceBlocked) {
    return { kind: 'governance_blocked', blocked: message.extra.governanceBlocked };
  }
  const isLegacyError = !message.variant && message.content.trim().startsWith('Error:');
  const isError = message.variant === 'error' || isLegacyError;
  // F212 Phase B precedence; only an error row may explain itself with the timeout panel.
  const selected = selectTerminalDiagnostics(message.extra, isError);
  return selected ? { kind: 'diagnostics', selected } : { kind: 'notice', isError };
}

/** Only standalone system errors render diagnostics. Responses own the full error in their body. */
export function projectRowTerminalDiagnostics(
  message: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): TerminalDiagnostics | null {
  if (isHiddenChatRow(message)) return null;
  if (message.type === 'system') {
    const surface = projectSystemRowSurface(message, timelineMessages);
    return surface.kind === 'diagnostics' ? surface.selected : null;
  }
  return null;
}
