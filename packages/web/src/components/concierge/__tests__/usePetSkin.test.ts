/**
 * F229 Phase E0: resolvePetSprite unit tests.
 *
 * Pure function — no React mount needed.
 * Tests projection + path resolution for all ConciergeBallState values.
 * R1 fix: skin-aware resolution (yarn-ball legacy compat + ragdoll-v1 projection).
 */

import { describe, expect, it } from 'vitest';
import { type AtlasSpriteResult, FALLBACK_SPRITE_PATH, resolvePetSprite } from '../usePetSkin';

describe('resolvePetSprite — ragdoll-v1 (projection)', () => {
  it('idle ballState → idle sprite', () => {
    expect(resolvePetSprite('idle', 'ragdoll-v1')).toBe('/concierge/skins/ragdoll-v1/idle.png');
  });

  it('thinking → running sprite (projection)', () => {
    expect(resolvePetSprite('thinking', 'ragdoll-v1')).toBe('/concierge/skins/ragdoll-v1/running.png');
  });

  it('found → review sprite', () => {
    expect(resolvePetSprite('found', 'ragdoll-v1')).toBe('/concierge/skins/ragdoll-v1/review.png');
  });

  it('error → failed sprite', () => {
    expect(resolvePetSprite('error', 'ragdoll-v1')).toBe('/concierge/skins/ragdoll-v1/failed.png');
  });

  it('sleeping → idle sprite (quiet fallback)', () => {
    expect(resolvePetSprite('sleeping', 'ragdoll-v1')).toBe('/concierge/skins/ragdoll-v1/idle.png');
  });

  it('listening → idle sprite (passive fallback)', () => {
    expect(resolvePetSprite('listening', 'ragdoll-v1')).toBe('/concierge/skins/ragdoll-v1/idle.png');
  });

  it('handoff → running sprite (transitioning)', () => {
    expect(resolvePetSprite('handoff', 'ragdoll-v1')).toBe('/concierge/skins/ragdoll-v1/running.png');
  });

  it('needs-confirmation → idle sprite (v0 defers waiting)', () => {
    expect(resolvePetSprite('needs-confirmation', 'ragdoll-v1')).toBe('/concierge/skins/ragdoll-v1/idle.png');
  });

  it('unknown state → idle sprite (fallback invariant)', () => {
    expect(resolvePetSprite('garbage', 'ragdoll-v1')).toBe('/concierge/skins/ragdoll-v1/idle.png');
  });

  it('defaults to ragdoll-v1 when skin omitted', () => {
    expect(resolvePetSprite('idle')).toBe('/concierge/skins/ragdoll-v1/idle.png');
  });
});

describe('resolvePetSprite — yarn-ball (legacy compat)', () => {
  it('idle → legacy direct path', () => {
    expect(resolvePetSprite('idle', 'yarn-ball')).toBe('/concierge/sprites/ragdoll/idle.png');
  });

  it('thinking → thinking.png (no projection, direct state name)', () => {
    expect(resolvePetSprite('thinking', 'yarn-ball')).toBe('/concierge/sprites/ragdoll/thinking.png');
  });

  it('found → found.png (direct)', () => {
    expect(resolvePetSprite('found', 'yarn-ball')).toBe('/concierge/sprites/ragdoll/found.png');
  });

  it('error → error.png (direct)', () => {
    expect(resolvePetSprite('error', 'yarn-ball')).toBe('/concierge/sprites/ragdoll/error.png');
  });

  it('sleeping → sleeping.png (direct)', () => {
    expect(resolvePetSprite('sleeping', 'yarn-ball')).toBe('/concierge/sprites/ragdoll/sleeping.png');
  });

  it('handoff → handoff.png (direct)', () => {
    expect(resolvePetSprite('handoff', 'yarn-ball')).toBe('/concierge/sprites/ragdoll/handoff.png');
  });

  it('needs-confirmation → confirm.png (legacy filename differs from ballState)', () => {
    // Legacy sprite is "confirm.png", not "needs-confirmation.png" — filename audit R2
    expect(resolvePetSprite('needs-confirmation', 'yarn-ball')).toBe('/concierge/sprites/ragdoll/confirm.png');
  });

  it('unknown state → idle.png fallback', () => {
    expect(resolvePetSprite('garbage', 'yarn-ball')).toBe('/concierge/sprites/ragdoll/idle.png');
  });
});

describe('FALLBACK_SPRITE_PATH', () => {
  it('points to idle.png in ragdoll-v1', () => {
    expect(FALLBACK_SPRITE_PATH).toBe('/concierge/skins/ragdoll-v1/idle.png');
  });
});

// ---------------------------------------------------------------------------
// yanyan-codex atlas skin (E1: 9-state animated spritesheet)
// ---------------------------------------------------------------------------
describe('resolvePetSprite — yanyan-codex (atlas)', () => {
  it('returns atlas result for yanyan-codex skin', () => {
    const result = resolvePetSprite('idle', 'yanyan-codex');
    expect(result).toMatchObject({
      kind: 'atlas',
      src: '/concierge/skins/yanyan-codex/spritesheet.webp',
      petState: 'idle',
    });
  });

  it('atlas result includes row index for idle (row 0)', () => {
    const result = resolvePetSprite('idle', 'yanyan-codex') as AtlasSpriteResult;
    expect(result.kind).toBe('atlas');
    expect(result.row).toBe(0);
  });

  it('thinking → running (V1 atlas projection)', () => {
    const result = resolvePetSprite('thinking', 'yanyan-codex') as AtlasSpriteResult;
    expect(result.kind).toBe('atlas');
    expect(result.petState).toBe('running');
  });

  it('needs-confirmation → waiting (V1 atlas projection)', () => {
    const result = resolvePetSprite('needs-confirmation', 'yanyan-codex') as AtlasSpriteResult;
    expect(result.kind).toBe('atlas');
    expect(result.petState).toBe('waiting');
  });

  it('handoff → running-right (V1 atlas projection)', () => {
    const result = resolvePetSprite('handoff', 'yanyan-codex') as AtlasSpriteResult;
    expect(result.kind).toBe('atlas');
    expect(result.petState).toBe('running-right');
  });

  it('error → failed (atlas)', () => {
    const result = resolvePetSprite('error', 'yanyan-codex') as AtlasSpriteResult;
    expect(result.kind).toBe('atlas');
    expect(result.petState).toBe('failed');
  });

  it('unknown state → idle (atlas fallback)', () => {
    const result = resolvePetSprite('garbage', 'yanyan-codex') as AtlasSpriteResult;
    expect(result.kind).toBe('atlas');
    expect(result.petState).toBe('idle');
  });

  it('atlas result includes frame timing config', () => {
    const result = resolvePetSprite('idle', 'yanyan-codex') as AtlasSpriteResult;
    expect(result.frameCount).toBeGreaterThan(0);
    expect(result.frameDurations).toBeInstanceOf(Array);
    expect(result.frameDurations.length).toBe(result.frameCount);
    expect(result.cellWidth).toBe(192);
    expect(result.cellHeight).toBe(208);
  });
});

// ---------------------------------------------------------------------------
// xianxian-codex atlas skin (E1: 9-state animated spritesheet — 宪宪)
// ---------------------------------------------------------------------------
describe('resolvePetSprite — xianxian-codex (atlas)', () => {
  it('returns atlas result for xianxian-codex skin', () => {
    const result = resolvePetSprite('idle', 'xianxian-codex');
    expect(result).toMatchObject({
      kind: 'atlas',
      src: '/concierge/skins/xianxian-codex/spritesheet.webp',
      petState: 'idle',
    });
  });

  it('atlas result includes correct row for idle (row 0)', () => {
    const result = resolvePetSprite('idle', 'xianxian-codex') as AtlasSpriteResult;
    expect(result.row).toBe(0);
    expect(result.frameCount).toBe(6);
  });

  it('thinking → running (V1 projection, same as yanyan)', () => {
    const result = resolvePetSprite('thinking', 'xianxian-codex') as AtlasSpriteResult;
    expect(result.kind).toBe('atlas');
    expect(result.petState).toBe('running');
    expect(result.row).toBe(7);
  });

  it('handoff → running-right (V1 projection)', () => {
    const result = resolvePetSprite('handoff', 'xianxian-codex') as AtlasSpriteResult;
    expect(result.petState).toBe('running-right');
    expect(result.row).toBe(1);
  });

  it('error → failed (atlas)', () => {
    const result = resolvePetSprite('error', 'xianxian-codex') as AtlasSpriteResult;
    expect(result.petState).toBe('failed');
    expect(result.row).toBe(5);
  });

  it('unknown state → idle fallback', () => {
    const result = resolvePetSprite('garbage', 'xianxian-codex') as AtlasSpriteResult;
    expect(result.petState).toBe('idle');
  });

  it('atlas cell dimensions match spec (192×208)', () => {
    const result = resolvePetSprite('idle', 'xianxian-codex') as AtlasSpriteResult;
    expect(result.cellWidth).toBe(192);
    expect(result.cellHeight).toBe(208);
  });

  it('frameDurations array length matches frameCount', () => {
    const result = resolvePetSprite('idle', 'xianxian-codex') as AtlasSpriteResult;
    expect(result.frameDurations.length).toBe(result.frameCount);
  });
});

// ---------------------------------------------------------------------------
// Backward compat: ragdoll-v1 still returns string with expanded CodexPetState
// ---------------------------------------------------------------------------
describe('resolvePetSprite — ragdoll-v1 backward compat with 9-state', () => {
  it('returns string type for ragdoll-v1 (not atlas object)', () => {
    const result = resolvePetSprite('idle', 'ragdoll-v1');
    expect(typeof result).toBe('string');
  });

  it('new states gracefully degrade to existing sprites', () => {
    // These states didn't exist in V0's CodexPetState but now do.
    // ragdoll-v1 should map them to existing sprites via V0 projection.
    // V0: idle → idle, sleeping → idle, listening → idle, etc.
    const idlePath = '/concierge/skins/ragdoll-v1/idle.png';
    expect(resolvePetSprite('idle', 'ragdoll-v1')).toBe(idlePath);
    expect(resolvePetSprite('sleeping', 'ragdoll-v1')).toBe(idlePath);
  });
});
