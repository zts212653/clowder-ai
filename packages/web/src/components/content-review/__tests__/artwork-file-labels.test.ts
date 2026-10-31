import { expect, it } from 'vitest';
import { artworkApplicationName, artworkFileDate } from '../artwork-file-labels';

it('uses the shell language and 24-hour minute precision, retaining the year only for another year', () => {
  const now = new Date(2026, 9, 18);
  const date = new Date(2026, 9, 16, 21, 48, 37).toISOString();
  expect(artworkFileDate(date, 'zh', now)).toBe('10/16 21:48');
  expect(artworkFileDate(date, 'en', now)).toBe('10/16, 21:48');
  expect(artworkFileDate(new Date(2025, 9, 16, 21, 48).toISOString(), 'zh', now)).toBe('2025/10/16 21:48');
  expect(artworkFileDate('invalid', 'zh', now)).toBe('');
});
it('translates the identified Preview application without renaming another default application', () => {
  expect(artworkApplicationName('Preview', 'com.apple.Preview', '预览')).toBe('预览');
  expect(artworkApplicationName('Preview', 'org.example.viewer', '预览')).toBe('Preview');
  expect(artworkApplicationName('QuickTime Player', 'com.apple.QuickTimePlayerX', '预览')).toBe('QuickTime Player');
  expect(artworkApplicationName(undefined, undefined, '预览')).toBeUndefined();
});
