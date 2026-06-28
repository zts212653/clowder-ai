import { describe, expect, it } from 'vitest';
import {
  PET_STATE_PROJECTION_V0,
  PET_STATE_PROJECTION_V1,
  projectToPetState,
} from '../src/concierge/pet-skin-projection.js';

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

// ---------------------------------------------------------------------------
// V1 九態投影 (E1: atlas-based animated skins)
// ---------------------------------------------------------------------------
describe('projectToPetState — v1 九態投影', () => {
  const proj = PET_STATE_PROJECTION_V1;

  // -- Direct mappings (same as V0) --
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

  it('sleeping → idle (quiet state)', () => {
    expect(projectToPetState('sleeping', proj)).toBe('idle');
  });

  // -- V1 changes: more granular mappings --
  it('listening → waiting (V1: dedicated waiting animation)', () => {
    // V0 mapped to idle; V1 has a waiting animation state
    expect(projectToPetState('listening', proj)).toBe('waiting');
  });

  it('needs-confirmation → waiting (V1: dedicated waiting animation)', () => {
    // V0 mapped to idle; V1 uses the waiting state for pending confirmation
    expect(projectToPetState('needs-confirmation', proj)).toBe('waiting');
  });

  it('handoff → running-right (V1: directional relay animation)', () => {
    // V0 mapped to running; V1 uses directional running-right for relay
    expect(projectToPetState('handoff', proj)).toBe('running-right');
  });

  // -- Fallback invariant --
  it('unknown value → idle (fallback invariant)', () => {
    expect(projectToPetState('totally-unknown-state', proj)).toBe('idle');
  });

  // -- Exhaustiveness: all ball states produce valid V1 CodexPetState --
  it('all ConciergeBallState values produce valid v1 CodexPetState', () => {
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
    const validPetStates = new Set([
      'idle',
      'running-right',
      'running-left',
      'waving',
      'jumping',
      'failed',
      'waiting',
      'running',
      'review',
    ]);
    for (const s of allBallStates) {
      const result = projectToPetState(s, proj);
      expect(validPetStates.has(result), `${s} → ${result} not in valid v1 set`).toBe(true);
    }
  });
});
