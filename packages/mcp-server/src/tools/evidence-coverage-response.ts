import { formatRecallMeta, type RecallMatchType } from '@cat-cafe/shared';
import type { ToolResult } from './file-tools.js';
import { successResult } from './file-tools.js';

export const COVERAGE_TOOL_RESPONSE_CHAR_BUDGET = 24_000;
const ITEM_FIELD_MAX_CHARS = 2_100;

export interface CoverageToolInput {
  query: string;
  scope?: string;
  mode?: string;
  limit?: number;
  coverage_offset?: number;
}

export interface CoverageToolData {
  totalHits: number;
  bySource: Record<string, { count: number; cap: number }>;
  matrix: CoverageToolItem[];
  degraded?: Array<{ source: string; reason: string }>;
  contract?: {
    latency: {
      budgetMs: number;
      elapsedMs: number;
      timedOut: boolean;
      eventLoopLagMaxMs?: number;
      abortPropagated?: boolean;
    };
    response: {
      budgetChars: number;
      serializedChars: number;
      truncated: boolean;
      omittedItems: number;
      oversizeItems?: number;
      hasMore?: boolean;
      drillDown?: { tool: string; params: Record<string, string> };
    };
  };
}

interface CoverageToolItem {
  anchor: string;
  title: string;
  kind: string;
  matchType: RecallMatchType;
  retrievalScore?: number;
  source: string;
  sourcePath?: string;
  expansionProvenance?: { source: string; via: string; edgeStrength: string };
  representation?: 'oversize-placeholder';
  identityDigest?: string;
  drillDown?: { tool: string; params: Record<string, string>; hint: string };
  drillUnavailable?: { code: string };
}

export function renderCoverageToolResponse(
  data: CoverageToolData,
  input: CoverageToolInput,
  queryLabel: string,
): ToolResult {
  const minimumRenderedItems = data.matrix.length === 0 ? 0 : 1;
  for (let renderedItems = data.matrix.length; renderedItems >= minimumRenderedItems; renderedItems--) {
    const text = renderCoverageCandidate(data, input, queryLabel, renderedItems);
    if (text.length <= COVERAGE_TOOL_RESPONSE_CHAR_BUDGET) return successResult(text);
  }
  throw new Error('Coverage MCP response cannot fit one bounded item and its continuation footer');
}

function renderCoverageCandidate(
  data: CoverageToolData,
  input: CoverageToolInput,
  queryLabel: string,
  renderedItems: number,
): string {
  const lines = [
    `Evidence search results: Found ${data.totalHits} result(s) for ${boundField(queryLabel)} [intent=coverage]:`,
    '📊 Coverage Search',
    '',
    ...Object.entries(data.bySource).map(([source, info]) => `  ${source}: ${info.count}/${info.cap}`),
    '',
  ];
  for (const item of data.matrix.slice(0, renderedItems)) lines.push(...renderItem(item));

  appendDegraded(lines, data.degraded);
  appendContract(lines, data, input, renderedItems);
  lines.push(
    formatRecallMeta({
      resultStatus: renderedItems === 0 ? 'no_results' : 'counted',
      resultCount: renderedItems,
      degraded: Boolean(data.degraded?.length),
      previewItems: data.matrix.slice(0, Math.min(renderedItems, 3)).map((item) => ({
        title: boundField(item.title, 160),
        anchor: boundField(item.anchor, 240),
        matchType: item.matchType,
        snippet: `${item.source} | ${item.kind}`,
      })),
      readNextHint:
        renderedItems === 0
          ? 'Coverage search returned no hits. Broaden terms or split docs/threads queries.'
          : 'Use the coverage matrix anchors as the source map, then drill into the relevant originals.',
    }),
  );
  return lines.join('\n');
}

function renderItem(item: CoverageToolItem): string[] {
  const provenance = item.expansionProvenance
    ? ` [${item.expansionProvenance.source} via ${boundField(item.expansionProvenance.via)} | edgeStrength: ${item.expansionProvenance.edgeStrength}]`
    : '';
  const retrievalScore = item.retrievalScore == null ? '' : ` | retrievalScore: ${item.retrievalScore}`;
  return [
    `[matchType:${item.matchType}] ${boundField(item.title)}`,
    `  anchor: ${boundField(item.anchor)}`,
    `  source: ${item.source}${retrievalScore}${provenance}`,
    ...(item.sourcePath ? [`  sourcePath: ${boundField(item.sourcePath)}`] : []),
    ...(item.representation ? [`  representation: ${item.representation}`] : []),
    ...(item.identityDigest ? [`  identityDigest: ${boundField(item.identityDigest, 80)}`] : []),
    ...(item.drillDown ? [`  drillDown: ${formatItemDrill(item.drillDown)}`] : []),
    ...(item.drillUnavailable ? [`  drillUnavailable: ${boundField(item.drillUnavailable.code, 120)}`] : []),
    '',
  ];
}

function formatItemDrill(drill: NonNullable<CoverageToolItem['drillDown']>): string {
  const params = Object.entries(drill.params)
    .slice(0, 4)
    .map(([key, value]) => `${boundField(key, 80)}=${boundField(value, 180)}`)
    .join(', ');
  return `${boundField(drill.tool, 120)}${params ? ` (${params})` : ''}`;
}

function appendDegraded(lines: string[], degraded: CoverageToolData['degraded']): void {
  if (!degraded?.length) return;
  lines.push('⚠️ Degraded sources:');
  for (const item of degraded) lines.push(`  ${item.source}: ${boundField(item.reason)}`);
  lines.push('');
}

function appendContract(
  lines: string[],
  data: CoverageToolData,
  input: CoverageToolInput,
  renderedItems: number,
): void {
  const contract = data.contract;
  if (contract) {
    lines.push(`  latencyMs: ${contract.latency.elapsedMs}/${contract.latency.budgetMs}`);
    lines.push(`  latencyStatus: ${contract.latency.timedOut ? 'partial/degraded — deadline reached' : 'complete'}`);
    if (contract.latency.eventLoopLagMaxMs != null) {
      lines.push(`  eventLoopLagMaxMs: ${contract.latency.eventLoopLagMaxMs.toFixed(2)}`);
    }
    if (contract.latency.abortPropagated != null) {
      lines.push(`  abortPropagated: ${contract.latency.abortPropagated}`);
    }
    lines.push(`  serializedChars: ${contract.response.serializedChars}/${contract.response.budgetChars}`);
  }
  const locallyOmitted = data.matrix.length - renderedItems;
  const omittedItems = locallyOmitted + (contract?.response.omittedItems ?? 0);
  const hasMore = locallyOmitted > 0 || contract?.response.hasMore === true;
  const truncated = locallyOmitted > 0 || contract?.response.truncated === true;
  if (omittedItems > 0) {
    lines.push(`⚠️ Response truncated by declared budget; ${omittedItems} item(s) omitted.`);
  } else if ((contract?.response.oversizeItems ?? 0) > 0) {
    lines.push(`⚠️ Response includes ${contract?.response.oversizeItems} oversize placeholder(s).`);
  }

  const drillDown = locallyOmitted > 0 ? localDrillDown(input, renderedItems) : contract?.response.drillDown;
  if (contract) lines.push(`  hasMore: ${hasMore}`);
  if (drillDown) {
    const params = Object.entries(drillDown.params)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    lines.push(`  drillDown: ${drillDown.tool}${params ? ` (${params})` : ''}`);
  }
  if (contract || truncated) lines.push('');
}

function localDrillDown(input: CoverageToolInput, renderedItems: number) {
  return {
    tool: 'cat_cafe_search_evidence',
    params: {
      query: input.query,
      intent: 'coverage',
      scope: input.scope ?? 'all',
      mode: input.mode ?? 'hybrid',
      limit: String(input.limit ?? 5),
      coverage_offset: String((input.coverage_offset ?? 0) + renderedItems),
    },
  };
}

function boundField(value: string, maxChars = ITEM_FIELD_MAX_CHARS): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 34)}… [truncated; use drillDown]`;
}
