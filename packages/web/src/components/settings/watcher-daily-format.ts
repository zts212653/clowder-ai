import type { WatcherDailyMetric } from '@cat-cafe/shared';
import { type DailyDisplayRow, hasRequestFacts } from './watcher-daily-pages';

export function metricText(
  row: DailyDisplayRow,
  metric: Exclude<WatcherDailyMetric, 'workingContextTokens'>,
  partialPage = false,
): string {
  const current = hasRequestFacts(row);
  if (!current) return '未知（旧版日期归属未知）';
  const value = row.knownTotals[metric];
  if (value === null) return '未知';
  const incomplete = partialPage || row.coverage[metric] < row.usageSamples || row.legacyRecords > 0;
  return `${incomplete ? '至少 ' : ''}${value.toLocaleString('zh-CN')}`;
}

export function usageCoverageText(row: DailyDisplayRow, partialPage = false): string {
  if (!hasRequestFacts(row)) return '日期归属与完整度未知（旧版汇总）';
  if (row.unattributedLegacy.length > 0) {
    const coverage =
      row.usageSamples === 0
        ? '可归日用量未知'
        : `可归日部分：${row.reportedUsageSamples}/${row.usageSamples} 条有记录`;
    return `${coverage}（历史请求数未知）；另有 ${row.unattributedLegacy.length} 条日期归属未知`;
  }
  if (row.legacyRecords > 0) return `${row.reportedUsageSamples}/${row.usageSamples} 条有记录（历史请求数未知）`;
  if (row.modelAttempts === 0) return partialPage ? '已加载归日记录无请求' : '无模型请求（已归日记录）';
  return `${row.reportedUsageSamples}/${row.modelAttempts} 次有记录`;
}

export function requestCountText(row: DailyDisplayRow): string {
  if (!hasRequestFacts(row)) return row.modelAttempts > 0 ? `至少 ${row.modelAttempts}` : '未知';
  return row.legacyRecords > 0 ? `${row.modelAttempts}（另有历史请求数未知）` : String(row.modelAttempts);
}

export function contextBudgetText(row: DailyDisplayRow): string {
  const current = hasRequestFacts(row);
  if (!current) return '未知（旧版日期归属未知）';
  const value = row.knownTotals.workingContextTokens;
  if (value === null) return '未知';
  if (row.usageSamples === 0) return '—';
  const coverage = row.coverage.workingContextTokens;
  const unit = row.legacyRecords > 0 ? '条' : '次';
  return `${value.toLocaleString('zh-CN')}（${coverage}/${row.usageSamples} ${unit}有记录）`;
}

export function cacheRatioText(row: DailyDisplayRow, partialPage = false): string {
  const current = hasRequestFacts(row);
  if (!current) return '未知（旧版日期归属未知）';
  if (row.unattributedLegacy.length > 0 && row.usageSamples === 0) return '未知（日期归属未知）';
  if (current && row.usageSamples === 0) return '—';
  const { inputTokens, cacheReadTokens, samples } = row.cacheRatio;
  if (samples === 0 || inputTokens === 0) return '未知';
  const scope =
    samples < row.usageSamples || row.legacyRecords > 0 ? '（已报子集）' : partialPage ? '（已加载请求）' : '';
  return `${((cacheReadTokens / inputTokens) * 100).toFixed(1)}%${scope}`;
}
