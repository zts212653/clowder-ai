import type Database from 'better-sqlite3';
import { MessageCandidateAudit } from './message-candidate-audit.js';
import { messageLiteralRelevance } from './message-literal-relevance.js';
import { lexicalMessagePassages } from './message-passage-lexical.js';
import type { MessagePassageSearchExecution, MessagePassageSearchOptions } from './message-passage-search-types.js';
import { readMessagePassageState } from './message-passage-state.js';
import type { PassageResult } from './SqliteEvidenceStore.js';

interface MessagePassageSearchDeps {
  db: Database.Database;
  isEmbeddingAvailable(): Promise<boolean>;
  semanticSearch(limit: number, audit?: MessageCandidateAudit): Promise<PassageResult[]>;
  hybridSearch(
    lexical: PassageResult[],
    limit: number,
    accept: (passage: PassageResult) => boolean,
    compare?: (a: PassageResult, b: PassageResult) => number,
    audit?: MessageCandidateAudit,
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
  audit?: MessageCandidateAudit,
): (passage: PassageResult) => boolean {
  return (passage) => {
    const reject = () => {
      audit?.deniedIndex(passage);
      return false;
    };
    if (!anchors.has(passage.docAnchor) || !passage.passageId.startsWith('msg-')) return reject();
    if (!readMessagePassageState(db, passage).current) return reject();
    if (
      options.excludeSource &&
      passage.docAnchor === `thread-${options.excludeSource.threadId}` &&
      passage.passageId === `msg-${options.excludeSource.messageId}`
    )
      return reject();
    return true;
  };
}

async function retrieveVectors(
  query: string,
  lexical: PassageResult[],
  options: MessagePassageSearchOptions,
  deps: MessagePassageSearchDeps,
  meta: MessagePassageSearchExecution['meta'],
  accept: (passage: PassageResult) => boolean,
  audit?: MessageCandidateAudit,
): Promise<PassageResult[]> {
  if (options.mode === 'lexical') return lexical;
  if (!(await deps.isEmbeddingAvailable())) {
    audit?.nativeUnavailable();
    meta.degraded = true;
    meta.degradeReason = 'passage_embedding_unavailable';
    meta.effectiveMode = 'lexical';
    return lexical;
  }
  try {
    const passages =
      options.mode === 'semantic'
        ? await deps.semanticSearch(meta.candidateLimit, audit)
        : await deps.hybridSearch(
            lexical,
            meta.candidateLimit,
            accept,
            options.candidateOrder !== 'relevance' && options.sort === 'relevance'
              ? messageLiteralRelevance(query)?.compareHybrid
              : undefined,
            audit,
          );
    meta.semanticCandidatesLimited = true;
    return passages;
  } catch (error) {
    audit?.nativeUnavailable(true);
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
  const audit = MessageCandidateAudit.create(options.candidateAudit, pool);
  const anchors = eligibleAnchors(options);
  // Ordinary-search consumers own canonical display sorting. Both display
  // choices use the same relevance-ranked lexical input and RRF queue here.
  const sort = options.candidateOrder === 'relevance' ? 'relevance' : (options.sort ?? 'time');
  const retrievalOptions = options.candidateOrder === 'relevance' ? { ...options, sort } : options;
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
  const lexical = lexicalMessagePassages(deps.db, query, retrievalOptions, anchors, pool);
  audit?.order(1, lexical.slice(0, pool));
  meta.truncated = lexical.length > pool;
  const accept = messageAdmission(deps.db, anchors, options, audit);
  const passages = await retrieveVectors(query, lexical.slice(0, pool), retrievalOptions, deps, meta, accept, audit);
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
  audit?.order(5, eligible);
  const result: MessagePassageSearchExecution = {
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
  if (audit) {
    try {
      const snapshot = audit.snapshot();
      if (snapshot) options.onCandidateAudit?.(snapshot);
    } catch {
      /* Optional evidence never owns the existing result or cancellation. */
    }
  }
  return result;
}
