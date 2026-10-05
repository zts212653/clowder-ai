import { expect, it } from 'vitest';
import { tasteQuote, tasteRecordedDate, tasteTime } from '../taste-format';

it('formats month-only legacy records without inventing a day or an instant', () => {
  const year = new Date().getFullYear();
  expect(tasteRecordedDate(`${year}-05`)).toBe('5月');
  expect(tasteRecordedDate(`${year - 1}-03`)).toBe(`${year - 1}年3月`);
  expect(tasteRecordedDate(`${year}-05-18`)).toBe('5月18日');
  expect(tasteRecordedDate('时间不详')).toBe('时间不详');
});

it('frames a quote once and preserves quotes inside the original sentence', () => {
  expect(tasteQuote('“"先看实物"”')).toBe('“先看实物”');
  expect(tasteQuote('"他说「先看」"')).toBe('“他说「先看」”');
  expect(tasteQuote('开头有"引号')).toBe('“开头有"引号”');
});
it('an instant near UTC midnight displays the actual previous local day without seconds', () => {
  expect(tasteTime(Date.parse('2026-08-26T03:26:25Z'), 'America/Los_Angeles', new Date('2026-10-03T00:00:00Z'))).toBe(
    '8月25日 20:26',
  );
});
it('older instants include their year, and current-year comparison uses the same time zone', () => {
  expect(tasteTime(Date.parse('2025-08-26T03:26:25Z'), 'America/Los_Angeles', new Date('2026-10-03T00:00:00Z'))).toBe(
    '2025年8月25日 20:26',
  );
  expect(tasteTime(Date.parse('2025-12-31T23:00:00Z'), 'America/Los_Angeles', new Date('2026-01-01T00:00:00Z'))).toBe(
    '12月31日 15:00',
  );
});
