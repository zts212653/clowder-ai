import { parseRecallMetaFromText } from '@cat-cafe/shared';
import type { ToolEvent } from '@/stores/chat-types';
import {
  applyResultToRecall,
  findPendingSearchIndex,
  isSearchEvidenceResultText,
  parseRecallToolInput,
  parseResultQueryFromText,
} from './recall-result-parser';
import type { RecallEvent } from './recall-types';

const TOOLS = ['search_evidence', 'graph_resolve', 'list_recent'];
export function normalizeRecallTool(label: string): string | undefined {
  const name = label.split(' → ').pop() ?? label;
  return TOOLS.find((tool) => name === tool || name.endsWith(`_${tool}`));
}

/** Parse ONE message's events. Never pair across cats, messages or invocations. */
export function filterRecallEvents(events: ToolEvent[]): RecallEvent[] {
  const recalls: RecallEvent[] = [];
  const pending: Array<{ recall: RecallEvent; toolUseId?: string; catId?: string }> = [];
  for (const event of events) {
    const toolName = normalizeRecallTool(event.label);
    const catId = event.label.match(/^(.+?) [→←] /)?.[1];
    if (event.type === 'tool_use' && toolName) {
      const params = parseRecallToolInput(event.detail);
      const recall: RecallEvent = {
        id: event.id,
        toolName,
        catId,
        query: params.query || params.q || params.anchor || (toolName === 'search_evidence' ? '(unknown)' : ''),
        mode: params.mode,
        scope: params.scope,
        timestamp: event.timestamp,
      };
      recalls.push(recall);
      pending.push({ recall, toolUseId: event.toolUseId, catId });
      continue;
    }
    if (event.type !== 'tool_result') continue;
    const text = event.resultMeta ? `${event.detail ?? ''}\n${event.resultMeta}` : (event.detail ?? '');
    const eligible = pending.filter((item) => !catId || !item.catId || item.catId === catId);
    let match = event.toolUseId ? eligible.find((item) => item.toolUseId === event.toolUseId) : undefined;
    if (!event.toolUseId) {
      if (isSearchEvidenceResultText(text)) {
        // Preserve query-aware pairing of interleaved searches, including old providers.
        const index = findPendingSearchIndex(
          eligible.map((item) => item.recall).filter((item) => item.toolName === 'search_evidence'),
          parseResultQueryFromText(text),
        );
        match = eligible.filter((item) => item.recall.toolName === 'search_evidence')[index];
      } else if (parseRecallMetaFromText(text)) {
        const graphQuery = text.match(/Graph for "([^"]+)"/)?.[1];
        const candidates = eligible.filter((item) =>
          graphQuery
            ? item.recall.toolName === 'graph_resolve' && item.recall.query === graphQuery
            : item.recall.toolName === 'list_recent',
        );
        if (candidates.length === 1) match = candidates[0];
      }
    }
    if (!match) continue;
    applyResultToRecall(match.recall, text, parseResultQueryFromText(text));
    if (
      !parseRecallMetaFromText(text) &&
      (event.status === 'error' || /Evidence search (?:request )?failed/.test(text))
    ) {
      match.recall.resultStatus = 'error';
      delete match.recall.resultCount;
    }
    pending.splice(pending.indexOf(match), 1);
  }
  return recalls;
}
