import type Database from 'better-sqlite3';
import { lexicalMessagePassages } from './message-passage-lexical.js';
import type { MessagePassageSearchExecution, MessagePassageSearchOptions } from './message-passage-search-types.js';
import { readMessagePassageState } from './message-passage-state.js';
import type { PassageResult } from './SqliteEvidenceStore.js';

interface MessagePassageSearchDeps {
  db: Database.Database;
  isEmbeddingAvailable(): Promise<boolean>;
  semanticSearch(limit: number): Promise<PassageResult[]>;
  hybridSearch(
    lexical: PassageResult[],
    limit: number,
    accept: (passage: PassageResult) => boolean,
  ): Promise<PassageResult[]>;
}

function eligibleAnchors(options: MessagePassageSearchOptions): Set<string> {
  const ids = options.threadId
    ? options.visibleThreadIds.filter((id) => id === options.threadId)
    : options.visibleThreadIds;
  return new Set(ids.map((id) => `thread-${id}`));
}

function messageAdmission(
  db: Database.Database,
  anchors: Set<string>,
  options: MessagePassageSearchOptions,
): (passage: PassageResult) => boolean {
  return (passage) => {
    if (!anchors.has(passage.docAnchor) || !passage.passageId.startsWith('msg-')) return false;
    if (!readMessagePassageState(db, passage).current) return false;
    if (
      options.excludeSource &&
      passage.docAnchor === `thread-${options.excludeSource.threadId}` &&
      passage.passageId === `msg-${options.excludeSource.messageId}`
    )
      return false;
    return true;
  };
}

async function retrieveVectors(
  lexical: PassageResult[],
  options: MessagePassageSearchOptions,
  deps: MessagePassageSearchDeps,
  meta: MessagePassageSearchExecution['meta'],
  accept: (passage: PassageResult) => boolean,
): Promise<PassageResult[]> {
  if (options.mode === 'lexical') return lexical;
  if (!(await deps.isEmbeddingAvailable())) {
    meta.degraded = true;
    meta.degradeReason = 'passage_embedding_unavailable';
    meta.effectiveMode = 'lexical';
    return lexical;
  }
  try {
    const passages =
      options.mode === 'semantic'
        ? await deps.semanticSearch(meta.candidateLimit)
        : await deps.hybridSearch(lexical, meta.candidateLimit, accept);
    meta.semanticCandidatesLimited = true;
    return passages;
  } catch (error) {
    options.signal?.throwIfAborted();
    if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) throw error;
    meta.degraded = true;
    meta.degradeReason = 'passage_vector_search_error';
    meta.effectiveMode = 'lexical';
    return lexical;
  }
}

export async function searchMessagePassages(
  query: string,
  options: MessagePassageSearchOptions,
  deps: MessagePassageSearchDeps,
): Promise<MessagePassageSearchExecution> {
  const pool = options.candidateLimit ?? 2000;
  if (!Number.isInteger(pool) || pool < 1 || pool > 2000) throw new Error('Invalid message candidate limit');
  options.signal?.throwIfAborted();
  const anchors = eligibleAnchors(options);
  const sort = options.sort ?? 'time';
  const mode = options.mode ?? 'hybrid';
  const meta: MessagePassageSearchExecution['meta'] = {
    sort,
    candidateLimit: pool,
    truncated: false,
    semanticCandidatesLimited: false,
    sourceCoverage: 'unknown',
    freshness: 'unknown',
    degraded: false,
    effectiveMode: mode,
  };
  if (!query.trim() || anchors.size === 0) return { passages: [], meta };
  const lexical = lexicalMessagePassages(deps.db, query, options, anchors, pool);
  meta.truncated = lexical.length > pool;
  const accept = messageAdmission(deps.db, anchors, options);
  const passages = await retrieveVectors(lexical.slice(0, pool), options, deps, meta, accept);
  options.signal?.throwIfAborted();
  const seen = new Set<string>();
  const eligible = passages.filter((passage) => {
    if (!accept(passage)) return false;
    const key = JSON.stringify([passage.docAnchor, passage.passageId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (sort === 'time')
    eligible.sort(
      (a, b) =>
        (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
        a.docAnchor.localeCompare(b.docAnchor) ||
        a.passageId.localeCompare(b.passageId),
    );
  return {
    passages: eligible.map((passage) => ({
      docAnchor: passage.docAnchor,
      passageId: passage.passageId,
      threadId: passage.docAnchor.slice('thread-'.length),
      messageId: passage.passageId.slice('msg-'.length),
      content: passage.content,
      speaker: passage.speaker ?? undefined,
      createdAt: passage.createdAt ?? undefined,
      match: passage._semanticHit ? (passage._alsoLexical ? 'hybrid' : 'semantic') : 'lexical',
    })),
    meta,
  };
}
