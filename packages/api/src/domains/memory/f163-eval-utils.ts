/**
 * F163: Evaluation utilities — NDCG@k, MRR, gold set runner.
 * Used by f163-eval.ts script and tests.
 */

export interface GoldQuery {
  query: string;
  relevantAnchors: string[];
  relevance: Record<string, number>;
  shouldHitConstitutional?: boolean;
}

export interface GoldSet {
  version: number;
  queries: GoldQuery[];
}

export interface EvalResult {
  queryCount: number;
  meanNDCG: number;
  meanMRR: number;
  perQuery: Array<{
    query: string;
    ndcg: number;
    mrr: number;
    returnedAnchors: string[];
  }>;
}

/**
 * Compute NDCG@k (Normalized Discounted Cumulative Gain).
 * @param ranked - Returned anchor IDs in ranked order
 * @param relevance - Map of anchor → relevance grade (higher = more relevant)
 * @param k - Cutoff (default 10)
 */
export function computeNDCG(ranked: string[], relevance: Record<string, number>, k = 10): number {
  const dcg = computeDCG(ranked.slice(0, k), relevance);
  // Ideal: sort by relevance descending
  const idealOrder = Object.entries(relevance)
    .sort(([, a], [, b]) => b - a)
    .map(([anchor]) => anchor);
  const idcg = computeDCG(idealOrder.slice(0, k), relevance);
  if (idcg === 0) return 0;
  return dcg / idcg;
}

function computeDCG(ranked: string[], relevance: Record<string, number>): number {
  let dcg = 0;
  for (let i = 0; i < ranked.length; i++) {
    const rel = relevance[ranked[i]] ?? 0;
    dcg += (2 ** rel - 1) / Math.log2(i + 2); // i+2 because log2(1)=0
  }
  return dcg;
}

/**
 * Compute MRR (Mean Reciprocal Rank) for a single query.
 * Returns 1/rank of first relevant result, or 0 if none found.
 */
export function computeMRR(ranked: string[], relevantAnchors: string[]): number {
  const relevant = new Set(relevantAnchors);
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Run evaluation over a gold set using a search function.
 * @param goldSet - The gold set with queries and expected results
 * @param searchFn - Function that takes (query, opts) and returns results
 */
export async function runEvaluation(
  goldSet: GoldSet,
  searchFn: (query: string, opts?: { limit?: number }) => Promise<Array<{ anchor: string }>>,
): Promise<EvalResult> {
  if (goldSet.queries.length === 0) {
    return { queryCount: 0, meanNDCG: 0, meanMRR: 0, perQuery: [] };
  }

  const perQuery: EvalResult['perQuery'] = [];
  let totalNDCG = 0;
  let totalMRR = 0;

  for (const gq of goldSet.queries) {
    const results = await searchFn(gq.query, { limit: 10 });
    const returnedAnchors = results.map((r) => r.anchor);
    const ndcg = computeNDCG(returnedAnchors, gq.relevance, 10);
    const mrr = computeMRR(returnedAnchors, gq.relevantAnchors);
    totalNDCG += ndcg;
    totalMRR += mrr;
    perQuery.push({ query: gq.query, ndcg, mrr, returnedAnchors });
  }

  return {
    queryCount: goldSet.queries.length,
    meanNDCG: totalNDCG / goldSet.queries.length,
    meanMRR: totalMRR / goldSet.queries.length,
    perQuery,
  };
}
