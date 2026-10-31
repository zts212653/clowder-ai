import { createHash } from 'node:crypto';
import type { EvidenceSearchResponse } from './evidence.js';
import type { EvidenceResult } from './evidence-helpers.js';

/** F263 AC-A5 also applies to the complete topk JSON envelope. */
export const TOPK_RESPONSE_CHAR_BUDGET = 24_000;
const ENTITY_APPENDIX_CHARS_PER_RESULT = 1_500;

function bounded(value: string, max: number): string {
  if (value.length <= max) return value;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${value.slice(0, max - 20)}… [sha256:${digest}]`;
}

function projectEntityAppendix(result: EvidenceResult): EvidenceResult {
  if (!result.entityMatches?.length) return result;
  const selected: NonNullable<EvidenceResult['entityMatches']> = [];
  let chars = 0;
  for (const match of result.entityMatches) {
    const matchChars = JSON.stringify(match).length;
    if (chars + matchChars > ENTITY_APPENDIX_CHARS_PER_RESULT) break;
    selected.push(match);
    chars += matchChars;
  }
  const omitted = result.entityMatches.length - selected.length;
  return omitted === 0
    ? result
    : {
        ...result,
        entityMatches: selected,
        entityMatchesOmitted: omitted,
        entityMatchesDrillUnavailable: 'derived-appendix-not-pageable',
      };
}

function compactResult(result: EvidenceResult): EvidenceResult {
  const anchor = bounded(result.anchor, 400);
  const sourcePath = result.sourcePath ? bounded(result.sourcePath, 400) : undefined;
  return {
    title: bounded(result.title, 160),
    anchor,
    snippet: bounded(result.snippet, 160),
    matchRank: result.matchRank,
    sourceType: result.sourceType,
    boostSource: result.boostSource.slice(0, 4),
    ...(result.status ? { status: result.status } : {}),
    ...(result.authority ? { authority: bounded(result.authority, 80) } : {}),
    ...(result.updatedAt ? { updatedAt: bounded(result.updatedAt, 80) } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    ...(result.matchReason ? { matchReason: bounded(result.matchReason, 160) } : {}),
    ...(result.drillDown && JSON.stringify(result.drillDown).length <= 1_000 ? { drillDown: result.drillDown } : {}),
    ...(result.entityMatches?.length
      ? {
          entityMatchesOmitted: result.entityMatches.length,
          entityMatchesDrillUnavailable: 'derived-appendix-not-pageable' as const,
        }
      : {}),
    ...(result.passages?.length ? { passagesOmitted: result.passages.length } : {}),
    ...(anchor !== result.anchor || (result.sourcePath && sourcePath !== result.sourcePath)
      ? { sourceReferenceTruncated: true }
      : {}),
  };
}

function withResponse(
  body: EvidenceSearchResponse,
  omission: { entity: number; passages: number; expansion: number },
): EvidenceSearchResponse {
  const response = {
    budgetChars: TOPK_RESPONSE_CHAR_BUDGET,
    serializedChars: 0,
    truncated: true,
    omittedEntityMatches: omission.entity,
    omittedPassages: omission.passages,
    omittedExpansionHints: omission.expansion,
    detailContinuation: 'unavailable' as const,
  };
  const projected = { ...body, response };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const chars = JSON.stringify(projected).length;
    if (response.serializedChars === chars) break;
    response.serializedChars = chars;
  }
  return projected;
}

function countOmissions(original: EvidenceSearchResponse, projected: EvidenceSearchResponse) {
  return {
    entity:
      original.results.reduce((sum, item) => sum + (item.entityMatches?.length ?? 0), 0) -
      projected.results.reduce((sum, item) => sum + (item.entityMatches?.length ?? 0), 0),
    passages:
      original.results.reduce((sum, item) => sum + (item.passages?.length ?? 0), 0) -
      projected.results.reduce((sum, item) => sum + (item.passages?.length ?? 0), 0),
    expansion: (original.expansionHints?.length ?? 0) - (projected.expansionHints?.length ?? 0),
  };
}

/** Keeps every ranked result visible; derived detail has no invented continuation. */
export function boundTopkSearchResponse(body: EvidenceSearchResponse): EvidenceSearchResponse {
  if (JSON.stringify(body).length <= TOPK_RESPONSE_CHAR_BUDGET) return body;

  const appendixProjected = {
    ...body,
    results: body.results.map(projectEntityAppendix),
  };
  const withAppendixNotice = withResponse(appendixProjected, countOmissions(body, appendixProjected));
  if (JSON.stringify(withAppendixNotice).length <= TOPK_RESPONSE_CHAR_BUDGET) return withAppendixNotice;

  const compact: EvidenceSearchResponse = {
    results: body.results.map(compactResult),
    degraded: body.degraded,
    variantId: body.variantId,
    ...(body.degradeReason ? { degradeReason: bounded(body.degradeReason, 160) } : {}),
    ...(body.effectiveMode ? { effectiveMode: body.effectiveMode } : {}),
    ...(body.filterExecution ? { filterExecution: body.filterExecution } : {}),
  };
  const boundedResponse = withResponse(compact, countOmissions(body, compact));
  if (JSON.stringify(boundedResponse).length > TOPK_RESPONSE_CHAR_BUDGET) {
    throw new Error('Topk primary source references exceed the declared response budget');
  }
  return boundedResponse;
}
