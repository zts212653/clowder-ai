import { describe, expect, it } from 'vitest';
import { deriveActiveCats, statusLabel, statusTone } from '../status-helpers';

describe('statusLabel — liveness states (F118 AC-C1)', () => {
  it('returns 静默等待 for alive_but_silent', () => {
    expect(statusLabel('alive_but_silent')).toBe('静默等待');
  });

  it('returns 疑似卡住 for suspected_stall', () => {
    expect(statusLabel('suspected_stall')).toBe('疑似卡住');
  });
});

describe('statusTone — liveness states (F118 AC-C1)', () => {
  it('returns amber for alive_but_silent', () => {
    expect(statusTone('alive_but_silent')).toBe('text-amber-500');
  });

  it('returns orange for suspected_stall', () => {
    expect(statusTone('suspected_stall')).toBe('text-orange-600');
  });
});

describe('deriveActiveCats — slot-first truth source', () => {
  it('keeps legacy targetCats behavior when slot metadata is absent', () => {
    expect(deriveActiveCats({ targetCats: ['opus'], snapshotCats: ['codex'] })).toEqual(['opus', 'codex']);
  });

  it('prefers invocation slots over stale targetCats', () => {
    const active = deriveActiveCats({
      targetCats: ['codex'],
      snapshotCats: [],
      hasActiveInvocation: true,
      activeInvocations: {
        'inv-1': { catId: 'dare', mode: 'execute' },
      },
    });

    expect(active).toEqual(['dare']);
  });

  it('drops targetCats after invocation ends when no slots remain', () => {
    const active = deriveActiveCats({
      targetCats: ['codex'],
      snapshotCats: [],
      hasActiveInvocation: false,
      activeInvocations: {},
    });

    expect(active).toEqual([]);
  });

  it('keeps targetCats as degraded fallback while invocation is still active but slots are not ready', () => {
    const active = deriveActiveCats({
      targetCats: ['opus'],
      snapshotCats: [],
      hasActiveInvocation: true,
      activeInvocations: {},
    });

    expect(active).toEqual(['opus']);
  });

  it('returns cats from invocation slots when targetCats is empty', () => {
    const active = deriveActiveCats({
      targetCats: [],
      snapshotCats: [],
      hasActiveInvocation: true,
      activeInvocations: {
        'inv-1': { catId: 'opus', mode: 'ideate' },
        'inv-2': { catId: 'codex', mode: 'execute' },
      },
    });

    expect(active).toEqual(['opus', 'codex']);
  });

  it('dedupes repeated cats across multiple live invocation slots', () => {
    const active = deriveActiveCats({
      targetCats: [],
      snapshotCats: [],
      hasActiveInvocation: true,
      activeInvocations: {
        'inv-1': { catId: 'opus', mode: 'ideate' },
        'inv-2': { catId: 'opus', mode: 'execute' },
        'inv-3': { catId: 'codex', mode: 'execute' },
      },
    });

    expect(active).toEqual(['opus', 'codex']);
  });
});
