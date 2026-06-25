/**
 * Resolver Registry — F237 Phase 2-B
 *
 * Maps hookId → resolver instance. All 46 Tier 1 pipeline hooks.
 * Resolvers are stateless singletons — safe for concurrent invocations.
 */

import type { HookResolver } from '@cat-cafe/shared';
import {
  L1Resolver,
  L2Resolver,
  L3Resolver,
  L4Resolver,
  L5Resolver,
  L6Resolver,
  L7Resolver,
} from './layer-resolvers.js';
import {
  B1Resolver,
  C1Resolver,
  S1Resolver,
  S2Resolver,
  S3Resolver,
  S4Resolver,
  S5Resolver,
  S6Resolver,
  S7Resolver,
  S8Resolver,
  S9Resolver,
  S10Resolver,
  S11Resolver,
  S12Resolver,
  S13Resolver,
} from './session-resolvers.js';
import {
  D1Resolver,
  D2Resolver,
  D3Resolver,
  D4Resolver,
  D5Resolver,
  D6Resolver,
  D7Resolver,
  D8Resolver,
  D9Resolver,
  D10Resolver,
} from './turn-resolvers-a.js';
import {
  D11Resolver,
  D12Resolver,
  D13Resolver,
  D14Resolver,
  D15Resolver,
  D16Resolver,
  D17Resolver,
  D18Resolver,
  D19Resolver,
  D20Resolver,
  D21Resolver,
  N1Resolver,
  R1Resolver,
  R2Resolver,
} from './turn-resolvers-b.js';

// ---------------------------------------------------------------------------
// Singleton resolver instances (stateless, concurrent-safe)
// ---------------------------------------------------------------------------

const RESOLVER_MAP: ReadonlyMap<string, HookResolver> = new Map<string, HookResolver>([
  // Layer hooks (L1-L7) — governance core, always fire
  ['L1', new L1Resolver()],
  ['L2', new L2Resolver()],
  ['L3', new L3Resolver()],
  ['L4', new L4Resolver()],
  ['L5', new L5Resolver()],
  ['L6', new L6Resolver()],
  ['L7', new L7Resolver()],
  // Session-init hooks (S1-S13, B1, C1)
  ['S1', new S1Resolver()],
  ['S2', new S2Resolver()],
  ['S3', new S3Resolver()],
  ['S4', new S4Resolver()],
  ['S5', new S5Resolver()],
  ['S6', new S6Resolver()],
  ['S7', new S7Resolver()],
  ['S8', new S8Resolver()],
  ['S9', new S9Resolver()],
  ['S10', new S10Resolver()],
  ['S11', new S11Resolver()],
  ['S12', new S12Resolver()],
  ['S13', new S13Resolver()],
  ['B1', new B1Resolver()],
  ['C1', new C1Resolver()],
  // Per-turn hooks (D1-D21, R1-R2, N1)
  ['D1', new D1Resolver()],
  ['D2', new D2Resolver()],
  ['D3', new D3Resolver()],
  ['D4', new D4Resolver()],
  ['D5', new D5Resolver()],
  ['D6', new D6Resolver()],
  ['D7', new D7Resolver()],
  ['D8', new D8Resolver()],
  ['D9', new D9Resolver()],
  ['D10', new D10Resolver()],
  ['D11', new D11Resolver()],
  ['D12', new D12Resolver()],
  ['D13', new D13Resolver()],
  ['D14', new D14Resolver()],
  ['D15', new D15Resolver()],
  ['D16', new D16Resolver()],
  ['D17', new D17Resolver()],
  ['D18', new D18Resolver()],
  ['D19', new D19Resolver()],
  ['D20', new D20Resolver()],
  ['D21', new D21Resolver()],
  ['R1', new R1Resolver()],
  ['R2', new R2Resolver()],
  ['N1', new N1Resolver()],
]);

/** Get resolver for a hook ID. Returns undefined if no resolver registered. */
export function getResolver(hookId: string): HookResolver | undefined {
  return RESOLVER_MAP.get(hookId);
}

/** Get all registered resolver IDs. */
export function getRegisteredResolverIds(): readonly string[] {
  return [...RESOLVER_MAP.keys()];
}

/** Total number of registered resolvers. */
export const RESOLVER_COUNT = RESOLVER_MAP.size;

// Re-export for direct access
export { RESOLVER_MAP };
