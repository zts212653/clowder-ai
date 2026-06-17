import { describe, expect, it } from 'vitest';
import { PET_STATE_PROJECTION_V0, projectToPetState } from '../src/concierge/pet-skin-projection.js';

describe('projectToPetState — v0 四態投影', () => {
  const proj = PET_STATE_PROJECTION_V0;

  it('idle → idle', () => {
    expect(projectToPetState('idle', proj)).toBe('idle');
  });

  it('thinking → running (processing)', () => {
    expect(projectToPetState('thinking', proj)).toBe('running');
  });

  it('found → review (result ready)', () => {
    expect(projectToPetState('found', proj)).toBe('review');
  });

  it('error → failed', () => {
    expect(projectToPetState('error', proj)).toBe('failed');
  });

  it('sleeping → idle (fallback: quiet state)', () => {
    expect(projectToPetState('sleeping', proj)).toBe('idle');
  });

  it('listening → idle (fallback: passive)', () => {
    expect(projectToPetState('listening', proj)).toBe('idle');
  });

  it('handoff → running (transitioning)', () => {
    expect(projectToPetState('handoff', proj)).toBe('running');
  });

  it('needs-confirmation → idle (v0 defers waiting)', () => {
    expect(projectToPetState('needs-confirmation', proj)).toBe('idle');
  });

  it('unknown value → idle (fallback invariant)', () => {
    expect(projectToPetState('totally-unknown-state', proj)).toBe('idle');
  });

  it('all ConciergeBallState values produce valid v0 CodexPetState', () => {
    const allBallStates = [
      'idle',
      'sleeping',
      'listening',
      'thinking',
      'found',
      'needs-confirmation',
      'handoff',
      'error',
    ];
    const validPetStates = new Set(['idle', 'running', 'review', 'failed']);
    for (const s of allBallStates) {
      const result = projectToPetState(s, proj);
      expect(validPetStates.has(result), `${s} → ${result} not in valid set`).toBe(true);
    }
  });
});
