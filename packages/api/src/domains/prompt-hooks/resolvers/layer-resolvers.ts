/**
 * Layer Resolvers (L1-L7) — F237 Phase 2-B
 *
 * L1-L7 are the "governance layer" hooks from the L0 compiler.
 * They always fire with no dynamic variables — content is pure static template.
 * Resolver logic: unconditional fire (these are the immutable governance core).
 */

import type { AssemblerInput, HookResolver, ResolveResult } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// L1-L7: always-fire, no-vars resolvers
// ---------------------------------------------------------------------------

/** L1 — 平行世界自我意識 (Parallel World Awareness) */
export class L1Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}

/** L2 — 客观性 carry-over 段 (Objectivity Baseline) */
export class L2Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}

/** L3 — 传球三选一 + @ 路由规则 (Ball-Passing & Routing Rules) */
export class L3Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}

/** L4 — 五条铁律 (Five Iron Laws) */
export class L4Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}

/** L5 — MCP 工具 quick index */
export class L5Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}

/** L6 — 能力唤醒指南 (Capability Wakeup Guide) */
export class L6Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}

/** L7 — 协作哲学 (Collaboration Philosophy) */
export class L7Resolver implements HookResolver {
  resolve(_input: AssemblerInput): ResolveResult {
    return { status: 'fired', vars: {} };
  }
}
