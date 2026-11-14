/** F314-16: the classic and V2 Changes panels badge a file's git status the same way. */
import { describe, expect, it } from 'vitest';
import { getStatusInfo } from '@/components/workspace/git-file-status';

describe('getStatusInfo (F314-16)', () => {
  it('maps git status letters to the badge both panels show', () => {
    expect(['M', 'A', 'D', 'R', '?', '??'].map((s) => getStatusInfo(s).label)).toEqual(['M', 'A', 'D', 'R', 'U', 'U']);
  });

  it('shows an unknown status as itself in the muted colour', () => {
    expect(getStatusInfo('C')).toEqual({ label: 'C', color: 'text-cafe-muted' });
  });
});
