import { formatLiveVerdictMarkdown as formatCanonicalLiveVerdictMarkdown } from '../live-verdict-markdown.js';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';

/**
 * Render a VerdictHandoffPacket as a frontmatter-prefixed markdown document.
 * Used by `generateA2aLiveVerdict` for both operator-regen and Phase H cat-mediated
 * publish paths. Extracted from `eval-a2a-live-verdict.ts` to honor 350-line limit.
 */
export function formatLiveVerdictMarkdown(
  verdictId: string,
  packet: VerdictHandoffPacket,
  sourceSnapshotRef: string,
  domain: { domainId: string; featureId: string } = { domainId: 'eval:a2a', featureId: 'F167' },
): string {
  return formatCanonicalLiveVerdictMarkdown(verdictId, packet, sourceSnapshotRef, domain);
}
