import { describe, expect, it } from 'vitest';
import { formatDuration } from '@/components/game/GameResultScreen';

describe('GameResultScreen formatDuration', () => {
  it('formats seconds correctly', () => {
    expect(formatDuration(5000)).toBe('0:05');
    expect(formatDuration(65000)).toBe('1:05');
    expect(formatDuration(600000)).toBe('10:00');
  });

  it('handles zero duration', () => {
    expect(formatDuration(0)).toBe('0:00');
  });
});
