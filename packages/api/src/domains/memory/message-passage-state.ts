import type Database from 'better-sqlite3';
import type { MessagePassageCandidate, MessagePassageIndexState } from './message-passage-search-types.js';

/** The same derived recall guard used by IndexBuilder, re-read after asynchronous retrieval. */
export function readMessagePassageState(
  db: Database.Database,
  candidate: Pick<MessagePassageCandidate, 'docAnchor' | 'passageId' | 'content'>,
): MessagePassageIndexState {
  const row = db
    .prepare(`SELECT
    EXISTS(SELECT 1 FROM evidence_passages p JOIN evidence_docs d ON d.anchor=p.doc_anchor
      WHERE p.doc_anchor=? AND p.passage_id=? AND p.content=? AND d.kind='thread'
        AND NOT EXISTS(SELECT 1 FROM message_recall_index_suppressions s
          WHERE s.doc_anchor=p.doc_anchor AND s.passage_id=p.passage_id)) AS current,
    EXISTS(SELECT 1 FROM message_recall_index_suppressions WHERE doc_anchor=?) AS suppressThreadTitle`)
    .get(candidate.docAnchor, candidate.passageId, candidate.content, candidate.docAnchor) as {
    current: number;
    suppressThreadTitle: number;
  };
  return { current: row.current === 1, suppressThreadTitle: row.suppressThreadTitle === 1 };
}
