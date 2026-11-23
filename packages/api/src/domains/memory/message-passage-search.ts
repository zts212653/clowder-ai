import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { MessageCandidateAudit } from './message-candidate-audit.js';
import { messageLiteralRelevance } from './message-literal-relevance.js';
import { lexicalMessagePassages } from './message-passage-lexical.js';
import type { MessagePassageSearchExecution, MessagePassageSearchOptions } from './message-passage-search-types.js';
import { readMessagePassageState } from './message-passage-state.js';
import { MESSAGE_SEARCH_ADMISSION_RESERVE_MS, MESSAGE_VECTOR_BUDGET_MS } from './message-search-time-budgets.js';
import type { PassageResult } from './SqliteEvidenceStore.js';
import type { VectorSearchDegradeStage } from './vector-search-degrade-report.js';

interface MessagePassageSearchDeps {
  db: Database.Database;
  vectorStarted?(): void | Promise<void>;
  isEmbeddingAvailable(): Promise<boolean>;
  semanticSearch(limit: number, audit?: MessageCandidateAudit): Promise<PassageResult[]>;
  hybridSearch(
    lexical: PassageResult[],
    limit: number,
    accept: (passage: PassageResult) => boolean,
    compare?: (a: PassageResult, b: PassageResult) => number,
    audit?: MessageCandidateAudit,
  ): Promise<PassageResult[]>;
  reportVectorDegrade(stage: VectorSearchDegradeStage, error: unknown): void;
}

function checkReadLifetime(options: MessagePassageSearchOptions): void {
  options.signal?.throwIfAborted();
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
    throw new DOMException('Message search deadline exceeded', 'TimeoutError');
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
  lexicalMs: number,
  options: MessagePassageSearchOptions,
  deps: MessagePassageSearchDeps,
  meta: MessagePassageSearchExecution['meta'],
  accept: (passage: PassageResult) => boolean,
  audit?: MessageCandidateAudit,
): Promise<PassageResult[]> {
  if (options.mode === 'lexical') return lexical;
  const requestDeadline = options.requestDeadlineAt ?? options.deadlineAt;
  const budgetInsufficient = () =>
    meta.effectiveMode === 'hybrid' &&
    requestDeadline !== undefined &&
    Number.isFinite(requestDeadline) &&
    requestDeadline - Date.now() < MESSAGE_VECTOR_BUDGET_MS + lexicalMs + MESSAGE_SEARCH_ADMISSION_RESERVE_MS;
  const lexicalForBudget = () => {
    // Keep this still-live lexical read. Starting vectors here can consume the
    // time needed to replace a cancelled worker and admit its fresh replay.
    meta.degraded = true;
    meta.degradeReason = 'passage_vector_admission_budget_insufficient';
    meta.effectiveMode = 'lexical';
    return lexical;
  };
  if (budgetInsufficient()) return lexicalForBudget();
  const embeddingAvailable = await deps.isEmbeddingAvailable();
  // Availability can await a provider probe. Re-evaluate the remaining request
  // budget afterwards, while the execution window still owns cancellation.
  checkReadLifetime(options);
  if (!embeddingAvailable) {
    audit?.nativeUnavailable();
    meta.degraded = true;
    meta.degradeReason = 'passage_embedding_unavailable';
    meta.effectiveMode = 'lexical';
    return lexical;
  }
  if (budgetInsufficient()) return lexicalForBudget();
  try {
    await deps.vectorStarted?.();
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
    deps.reportVectorDegrade(
      options.mode === 'semantic' ? 'message_passage_semantic' : 'message_passage_hybrid',
      error,
    );
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
  checkReadLifetime(options);
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
  const lexicalStarted = performance.now();
  const lexical = lexicalMessagePassages(deps.db, query, retrievalOptions, anchors, pool);
  const lexicalMs = Math.max(0, performance.now() - lexicalStarted);
  checkReadLifetime(options);
  audit?.order(1, lexical.slice(0, pool));
  meta.truncated = lexical.length > pool;
  const accept = messageAdmission(deps.db, anchors, options, audit);
  const passages = await retrieveVectors(
    query,
    lexical.slice(0, pool),
    lexicalMs,
    retrievalOptions,
    deps,
    meta,
    accept,
    audit,
  );
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
