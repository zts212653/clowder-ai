import { describe, expect, it } from 'vitest';
import {
  PAW_FEEL_DISPOSITION_STATES,
  PAW_FEEL_INBOX_SORTS,
  PAW_FEEL_NO_ACTION_REASONS,
  type PawFeelDispositionProjection,
} from '../types/paw-feel-disposition.js';

describe('F278 paw-feel disposition shared contract', () => {
  it('exposes the complete responsibility state vocabulary', () => {
    expect(PAW_FEEL_DISPOSITION_STATES).toEqual([
      'new',
      'seen',
      'route_pending',
      'routed',
      'closed',
      'duplicate',
      'no_action',
      'fix',
    ]);
  });

  it('keeps no-action reasons enumerated', () => {
    expect(PAW_FEEL_NO_ACTION_REASONS).toEqual([
      'working_as_intended',
      'insufficient_evidence',
      'out_of_scope',
      'superseded',
      'not_actionable',
      'parser_false_positive',
    ]);
  });

  it('keeps inbox ordering explicit across API, MCP and Workspace', () => {
    expect(PAW_FEEL_INBOX_SORTS).toEqual(['newest', 'oldest']);
  });

  it('names denominator facts without fabricating a problem-family count', () => {
    const denominator = {
      reportOccurrences: 4,
      uniqueSourceMessages: 3,
      historicalBackfill: 2,
      postActivationIntake: 2,
      typedConfirmed: 1,
      ambiguousOrContaminated: 3,
      reviewBundles: 3,
      problemFamilies: {
        status: 'unavailable',
        reason: 'No authoritative grouping contract',
      },
    } as const;

    expect(denominator.problemFamilies.status).toBe('unavailable');
    expect('count' in denominator.problemFamilies).toBe(false);
  });

  it('models source identity and disposition without a marker-body field', () => {
    const projection = {
      signalId: 'message-1:digest:0',
      sourceMessageId: 'message-1',
      sourceThreadId: 'thread-1',
      sourceCatId: 'codex-sol',
      markerDigest: 'digest',
      sameDigestOrdinal: 0,
      markerIndex: 2,
      state: 'seen',
      sequence: 2,
      discoveredAt: '2026-07-26T00:00:00.000Z',
      lastTransitionAt: '2026-07-26T01:00:00.000Z',
      lastActorCatId: 'opus',
      backfilled: false,
      captureMethod: 'typed',
      captureAssessment: 'confirmed',
    } satisfies PawFeelDispositionProjection;

    expect(Object.keys(projection)).not.toContain('markerBody');
    expect(Object.keys(projection)).not.toContain('symptom');
    expect(Object.keys(projection)).not.toContain('sourceEvidence');
  });
});
