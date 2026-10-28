import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { findMonorepoRoot } from '../../utils/monorepo-root.js';
import { type DecisionSourceFact, decisionSourceKey, parseDecisionLedger } from './message-decision-ledger.js';
import { boundMessageSearchResponse, MESSAGE_SEARCH_RESPONSE_BUDGET } from './message-search-budget.js';

export interface DecisionIndexResult {
  status: 'ready' | 'unavailable';
  revision?: string;
  facts: Map<string, DecisionSourceFact[]>;
}
export interface MessageDecisionIndex {
  lookup(
    rows: readonly Pick<MessageSearchResult, 'threadId' | 'messageId'>[],
    context: {
      signal?: AbortSignal;
      deadlineAt?: number;
    },
  ): Promise<DecisionIndexResult>;
}
const exec = promisify(execFile);
const unavailable = (): DecisionIndexResult => ({ status: 'unavailable', facts: new Map() });
export const hasDecisionSourceCoordinate = (row: Pick<MessageSearchResult, 'messageId'>) =>
  /^\d{13,17}-\d{6}-[a-f0-9]{8}$/.test(row.messageId);

/** Compare declared meaning; commit and line are versioned locations, not a different decision. */
export function sameDeclaredDecision(left: DecisionSourceFact, right: DecisionSourceFact): boolean {
  const fields = (fact: DecisionSourceFact) => [
    fact.status,
    fact.conclusion,
    fact.featureId,
    fact.documentPath,
    fact.decidedBy ?? null,
    fact.decidedAt ?? null,
    fact.historical ?? false,
  ];
  return JSON.stringify(fields(left)) === JSON.stringify(fields(right));
}

/** Derived lookup of already-admitted coordinates, not another query/retrieval pipeline.
 * Pin the existing local origin/main ref; do not fetch, write, classify text or start a watcher. */
export class GitMessageDecisionIndex implements MessageDecisionIndex {
  constructor(
    private readonly root = findMonorepoRoot(),
    private readonly ref = 'origin/main',
  ) {}
  async lookup(
    rows: readonly Pick<MessageSearchResult, 'threadId' | 'messageId'>[],
    context: {
      signal?: AbortSignal;
      deadlineAt?: number;
    } = {},
  ): Promise<DecisionIndexResult> {
    const ids = [...new Set(rows.filter(hasDecisionSourceCoordinate).map((row) => row.messageId))];
    if (!ids.length) return { status: 'ready', facts: new Map() };
    const deadline = Math.min(context.deadlineAt ?? Infinity, Date.now() + 750);
    const git = async (args: string[]) => {
      const remaining = deadline - Date.now();
      if (remaining < 25) throw new Error('Decision source lookup budget exhausted');
      const { stdout } = await exec('git', args, {
        cwd: this.root,
        timeout: remaining,
        maxBuffer: 4 * 1024 * 1024,
        signal: context.signal,
        windowsHide: true,
      });
      return stdout;
    };
    try {
      const revision = (await git(['rev-parse', '--verify', `${this.ref}^{commit}`])).trim();
      let names: string;
      try {
        names = await git([
          'grep',
          '-l',
          '-z',
          '-F',
          ...ids.flatMap((id) => ['-e', id]),
          revision,
          '--',
          'docs/features',
        ]);
      } catch (error) {
        if ((error as { code?: unknown }).code === 1) return { status: 'ready', revision, facts: new Map() };
        throw error;
      }
      const files = names
        .split('\0')
        .filter(Boolean)
        .map((name) => name.slice(revision.length + 1));
      if (files.length > 32 || files.some((file) => !/^docs\/features\/F\d{3}[^/]*\.md$/.test(file)))
        return unavailable();
      const wanted = new Set(rows.map(decisionSourceKey));
      const facts = new Map<string, DecisionSourceFact[]>();
      for (const path of files) {
        for (const record of parseDecisionLedger(await git(['show', `${revision}:${path}`]), path, revision)) {
          const key = decisionSourceKey(record);
          if (!wanted.has(key)) continue;
          const prior = facts.get(key) ?? [];
          if (!prior.some((fact) => JSON.stringify(fact) === JSON.stringify(record.fact))) prior.push(record.fact);
          facts.set(key, prior);
        }
      }
      return { status: 'ready', revision, facts };
    } catch {
      return unavailable();
    }
  }
}

export async function attachDecisionSources(
  results: MessageSearchResult[],
  index: MessageDecisionIndex,
  context: { signal?: AbortSignal; deadlineAt?: number },
) {
  let read: DecisionIndexResult;
  try {
    read = await index.lookup(results, context);
  } catch {
    read = unavailable();
  }
  if (JSON.stringify([...read.facts]).length > MESSAGE_SEARCH_RESPONSE_BUDGET) read = unavailable();
  for (const row of results) {
    const fact = read.facts.get(decisionSourceKey(row));
    if (fact?.length) row.decisionSources = fact;
  }
  return { status: read.status, ...(read.revision ? { revision: read.revision } : {}) };
}

/** Optional decision facts never evict a canonical hit that fits without them. */
export function boundDecisionSearchResponse(response: MessageSearchResponse): MessageSearchResponse {
  const plain = response.results.map((row) => {
    const copy = { ...row };
    delete copy.decisionSources;
    return copy;
  });
  const plainMeta = { ...response.meta };
  delete plainMeta.decisionIndex;
  const base = boundMessageSearchResponse({ ...response, results: plain, meta: plainMeta });
  const labelled = boundMessageSearchResponse(response);
  if (labelled.results.length === base.results.length) return labelled;
  const unavailable = { ...base, meta: { ...base.meta, decisionIndex: { status: 'unavailable' as const } } };
  // Even the advisory status must fit without evicting an original hit. Leave
  // a few characters for the existing serialized-size fixed point's digits.
  return JSON.stringify(unavailable).length + 8 <= MESSAGE_SEARCH_RESPONSE_BUDGET
    ? boundMessageSearchResponse(unavailable)
    : base;
}
