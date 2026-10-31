import { buildSearchableMessageContent, type SearchableMessageContent } from './message-search-content.js';

type ThreadSummaryMessage = SearchableMessageContent & { id: string; catId?: string };
const SUMMARY_LIMIT = 3000;

/** Only this summary consumer is bounded; the canonical per-message projection stays complete. */
export function projectThreadMessageSummary(
  messages: readonly ThreadSummaryMessage[],
  suppressed: ReadonlySet<string>,
): string {
  let summary = '';
  for (const message of messages) {
    if (suppressed.has(message.id)) continue;
    const content = buildSearchableMessageContent(message);
    if (!content) continue;
    const turn = `[${message.catId ?? 'user'}] ${content}`;
    summary += summary ? `\n${turn}` : turn;
    // At exactly 3000, a later nonempty turn still decides whether an ellipsis is required.
    if (summary.length > SUMMARY_LIMIT) return `${summary.slice(0, SUMMARY_LIMIT - 3)}...`;
  }
  return summary;
}
