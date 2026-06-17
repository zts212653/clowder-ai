/**
 * F229 Phase E0: PetSkin sprite resolver.
 *
 * Pure function — conciergeState + skin → sprite path.
 * Skin-aware: ragdoll-v1 uses PET_STATE_PROJECTION_V0 (4-state),
 * yarn-ball uses legacy direct ConciergeBallState → sprite path (8-state).
 *
 * No React state/effect. Manifest async loading deferred to E1+ (multi-skin).
 */

import type { CodexPetState } from '@cat-cafe/shared';
import { PET_STATE_PROJECTION_V0, projectToPetState } from '@cat-cafe/shared';

/** V0 ragdoll-v1 skin base path (public static asset) */
const RAGDOLL_V1_BASE = '/concierge/skins/ragdoll-v1';

/** Legacy yarn-ball sprite base (pre-E0 transition sprites, 8-state direct mapping) */
const YARN_BALL_BASE = '/concierge/sprites/ragdoll';

/** Pet state → sprite filename (ragdoll-v1: 4 individual PNGs via projection) */
const PET_STATE_SPRITES: Record<CodexPetState, string> = {
  idle: 'idle.png',
  running: 'running.png',
  review: 'review.png',
  failed: 'failed.png',
};

/** Hard-fault fallback (skin load failure / missing state) */
export const FALLBACK_SPRITE_PATH = `${RAGDOLL_V1_BASE}/idle.png`;

/**
 * Valid ConciergeBallState values that have legacy sprites.
 * Used for yarn-ball unknown-state fallback.
 */
const KNOWN_BALL_STATES = new Set([
  'idle',
  'sleeping',
  'listening',
  'thinking',
  'found',
  'needs-confirmation',
  'handoff',
  'error',
]);

/**
 * Yarn-ball legacy filename overrides.
 * Where the on-disk sprite filename differs from the ConciergeBallState string.
 * Discovered via R2 filename audit: `confirm.png` exists, `needs-confirmation.png` does not.
 */
const YARN_BALL_FILENAME_OVERRIDES: Record<string, string> = {
  'needs-confirmation': 'confirm',
};

/**
 * Pure function: ConciergeBallState + skin → sprite URL.
 *
 * - 'ragdoll-v1' (default): project ballState → CodexPetState → sprite path
 * - 'yarn-ball': legacy direct mapping, ballState → `/concierge/sprites/ragdoll/{state}.png`
 *
 * Unknown/unmapped states fall back to idle in both paths.
 */
export function resolvePetSprite(ballState: string, skin: 'yarn-ball' | 'ragdoll-v1' = 'ragdoll-v1'): string {
  if (skin === 'yarn-ball') {
    // Legacy path: ConciergeBallState → legacy sprite filename (OQ-3 backward compat)
    // Some states have filenames that differ from the ballState string (e.g. confirm.png)
    const validState = KNOWN_BALL_STATES.has(ballState) ? ballState : 'idle';
    const filename = YARN_BALL_FILENAME_OVERRIDES[validState] ?? validState;
    return `${YARN_BALL_BASE}/${filename}.png`;
  }
  // Projection path: ConciergeBallState → CodexPetState → sprite file
  const petState = projectToPetState(ballState, PET_STATE_PROJECTION_V0);
  const filename = PET_STATE_SPRITES[petState] ?? PET_STATE_SPRITES.idle;
  return `${RAGDOLL_V1_BASE}/${filename}`;
}
