import { describe, expect, it } from 'vitest';
import { HOME_ROWS } from '../home-rows';

describe('one v3 tool catalogue', () => {
  it('contains all accepted activity/code/other destinations once', () => {
    expect(HOME_ROWS.map((row) => row.copyKey).sort()).toEqual(
      [
        'status',
        'tasks',
        'trajectory',
        'theater',
        'files',
        'changes',
        'git',
        'terminal',
        'browser',
        'recall',
        'voice',
        'films',
        'team',
        'schedule',
        'eval',
        'community',
        'capability-evolution',
      ].sort(),
    );
    expect(new Set(HOME_ROWS.map((row) => row.id)).size).toBe(HOME_ROWS.length);
  });
  it('gives each accepted tool its own glyph', () => {
    expect(new Set(HOME_ROWS.map((row) => row.icon)).size).toBe(HOME_ROWS.length);
  });
  it('voice opens an existing owner destination rather than keeping the picker open', () => {
    expect(HOME_ROWS.find((row) => row.copyKey === 'voice')?.kind).toBe('destination');
  });
});
