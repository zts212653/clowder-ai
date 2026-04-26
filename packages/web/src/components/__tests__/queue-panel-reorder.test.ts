/**
 * F175 Phase B: compareQueueEntries mirrors backend InvocationQueue.compareEntries.
 * Locks the frontend sorting behavior so optimistic reorder updates render correctly.
 */
import { describe, expect, it } from 'vitest';
import { compareQueueEntries } from '../QueuePanel';

const NOW = Date.now();

describe('compareQueueEntries (F175 B1 regression)', () => {
  it('explicit position comes before no position', () => {
    const a = { position: 0, createdAt: NOW + 100 };
    const b = { createdAt: NOW };
    expect(compareQueueEntries(a, b)).toBeLessThan(0);
  });

  it('no position comes after explicit position', () => {
    const a = { createdAt: NOW };
    const b = { position: 0, createdAt: NOW + 100 };
    expect(compareQueueEntries(a, b)).toBeGreaterThan(0);
  });

  it('lower position first among positioned entries', () => {
    const a = { position: 2, createdAt: NOW };
    const b = { position: 0, createdAt: NOW + 100 };
    expect(compareQueueEntries(a, b)).toBeGreaterThan(0);
  });

  it('urgent before normal when no positions', () => {
    const a = { priority: 'normal', createdAt: NOW } as const;
    const b = { priority: 'urgent', createdAt: NOW + 100 } as const;
    expect(compareQueueEntries(a, b)).toBeGreaterThan(0);
  });

  it('createdAt FIFO when same priority and no positions', () => {
    const a = { createdAt: NOW };
    const b = { createdAt: NOW + 100 };
    expect(compareQueueEntries(a, b)).toBeLessThan(0);
  });

  it('undefined priority treated as normal', () => {
    const a = { createdAt: NOW };
    const b = { priority: 'urgent', createdAt: NOW + 100 } as const;
    expect(compareQueueEntries(a, b)).toBeGreaterThan(0);
  });

  it('same position is a tie (returns 0)', () => {
    const a = { position: 1, createdAt: NOW + 50 };
    const b = { position: 1, createdAt: NOW };
    expect(compareQueueEntries(a, b)).toBe(0);
  });

  it('sorts a mixed array correctly: position > priority > createdAt', () => {
    const entries = [
      { id: 'normal-old', createdAt: NOW, priority: 'normal' as const },
      { id: 'urgent-new', createdAt: NOW + 200, priority: 'urgent' as const },
      { id: 'positioned', createdAt: NOW + 300, position: 5 },
      { id: 'normal-new', createdAt: NOW + 100, priority: 'normal' as const },
    ];
    const sorted = [...entries].sort(compareQueueEntries);
    expect(sorted.map((e) => e.id)).toEqual(['positioned', 'urgent-new', 'normal-old', 'normal-new']);
  });
});
