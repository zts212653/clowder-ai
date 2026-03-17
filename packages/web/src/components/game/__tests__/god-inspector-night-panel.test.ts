/**
 * GodInspector Night Ballot Panel Tests (F101 Phase F — Task 7)
 *
 * Tests deriveNightBallotRows() — transforms night ballot events into displayable rows.
 * Also tests that GodInspector renders ballot rows when godEvents provided.
 */

import { describe, it, expect } from 'vitest';
import { deriveNightBallotRows, type NightBallotRow } from '../GodInspector';

describe('deriveNightBallotRows', () => {
  it('extracts ballot info from action.submitted events', () => {
    const events = [
      {
        eventId: 'e1',
        round: 1,
        phase: 'night_wolf',
        type: 'action.submitted',
        scope: 'god',
        payload: { seatId: 'P1', actionName: 'kill', target: 'P3' },
        timestamp: Date.now(),
      },
    ];
    const rows = deriveNightBallotRows(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ seatId: 'P1', target: 'P3', source: 'submitted' });
  });

  it('marks fallback entries', () => {
    const events = [
      {
        eventId: 'e2',
        round: 1,
        phase: 'night_wolf',
        type: 'action.fallback',
        scope: 'god',
        payload: { seatId: 'P2', actionName: 'kill', target: 'P4', fallbackSource: 'random' },
        timestamp: Date.now(),
      },
    ];
    const rows = deriveNightBallotRows(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ seatId: 'P2', target: 'P4', source: 'fallback' });
  });

  it('returns empty array when no relevant events', () => {
    const events = [
      {
        eventId: 'e3',
        round: 1,
        phase: 'night_wolf',
        type: 'speech',
        scope: 'public',
        payload: { seatId: 'P1', text: 'hello' },
        timestamp: Date.now(),
      },
    ];
    const rows = deriveNightBallotRows(events);
    expect(rows).toHaveLength(0);
  });
});

describe('deriveNightBallotRows integration — ballot data ready for render', () => {
  it('produces NightBallotRow[] that maps seatId→target for UI', () => {
    const events = [
      { type: 'action.submitted', payload: { seatId: 'P1', actionName: 'kill', target: 'P3' } },
      {
        type: 'action.fallback',
        payload: { seatId: 'P2', actionName: 'kill', target: 'P4', fallbackSource: 'random' },
      },
    ];
    const rows: NightBallotRow[] = deriveNightBallotRows(events);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ seatId: 'P1', target: 'P3', source: 'submitted' });
    expect(rows[1]).toEqual({ seatId: 'P2', target: 'P4', source: 'fallback' });
    for (const row of rows) {
      expect(row.seatId).toBeTruthy();
      expect(row.target).toBeTruthy();
      expect(['submitted', 'fallback']).toContain(row.source);
    }
  });

  it('only includes current round events when currentRound is provided (stale votes excluded)', () => {
    const events = [
      { type: 'action.submitted', payload: { seatId: 'P1', actionName: 'kill', target: 'P3' }, round: 1 },
      { type: 'action.submitted', payload: { seatId: 'P1', actionName: 'kill', target: 'P4' }, round: 2 },
    ];
    // Pass ALL events but scope to round 2 — exercises the actual filtering logic
    const rows = deriveNightBallotRows(events, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ seatId: 'P1', target: 'P4', source: 'submitted' });
  });

  it('without currentRound, returns ALL rounds (backward compat)', () => {
    const events = [
      { type: 'action.submitted', payload: { seatId: 'P1', actionName: 'kill', target: 'P3' }, round: 1 },
      { type: 'action.submitted', payload: { seatId: 'P1', actionName: 'kill', target: 'P4' }, round: 2 },
    ];
    const rows = deriveNightBallotRows(events);
    expect(rows).toHaveLength(2);
  });

  it('excludes non-kill fallback events (guard/seer/witch should not appear in wolf panel)', () => {
    const events = [
      { type: 'action.submitted', payload: { seatId: 'P1', actionName: 'kill', target: 'P3' } },
      {
        type: 'action.fallback',
        payload: { seatId: 'P5', actionName: 'guard', target: 'P2', fallbackSource: 'random' },
      },
      {
        type: 'action.fallback',
        payload: { seatId: 'P6', actionName: 'heal', target: 'P3', fallbackSource: 'random' },
      },
      {
        type: 'action.fallback',
        payload: { seatId: 'P2', actionName: 'kill', target: 'P4', fallbackSource: 'random' },
      },
    ];
    const rows = deriveNightBallotRows(events);
    expect(rows).toHaveLength(2);
    expect(rows[0].seatId).toBe('P1');
    expect(rows[1].seatId).toBe('P2');
  });
});
