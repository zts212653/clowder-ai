import { summarizeWatcherDailyRow, type WatcherDailyContribution } from '@cat-cafe/shared';
import { expect, it } from 'vitest';
import { usageCoverageText } from '../watcher-daily-format';

const undated: WatcherDailyContribution = {
  invocationId: 'undated',
  legacy: true,
  failed: false,
  usages: [{ reportedAt: 1, inputTokens: 100 }],
};
function requests(reported: number): WatcherDailyContribution {
  return {
    invocationId: 'dated',
    legacy: false,
    failed: false,
    usages: Array.from({ length: 7 }, (_, index) => (index < reported ? { reportedAt: 1, inputTokens: 1 } : null)),
  };
}

it.each([0, 6, 7])('keeps %i/7 reported coverage beside an undated whole summary', (reported) => {
  const row = summarizeWatcherDailyRow('line', [requests(reported), undated]);
  expect(usageCoverageText(row)).toContain(`${reported}/7 条有记录`);
  expect(usageCoverageText(row)).toContain('另有 1 条日期归属未知');
  expect(usageCoverageText(row)).toContain('历史请求数未知');
});

it('counts a same-day whole summary as an entry rather than one request', () => {
  const row = summarizeWatcherDailyRow('line', [
    requests(6),
    undated,
    { ...undated, invocationId: 'same-day', legacyDayKnown: true },
  ]);
  expect(usageCoverageText(row)).toContain('7/8 条有记录');
  expect(usageCoverageText(row)).toContain('历史请求数未知');
});

it('keeps attribution unknown when there are no attributable samples', () => {
  expect(usageCoverageText(summarizeWatcherDailyRow('line', [undated]))).toContain('可归日用量未知');
});
