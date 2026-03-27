/**
 * F139 Phase 1b: ActorResolver — maps actor.role + costTier to a catId.
 *
 * Uses injectable roster getter (decoupled from cat-config-loader singleton)
 * so tests can provide mock rosters without touching global state.
 */
import type { ActorRole, CostTier } from './types.js';

interface RosterEntry {
  family: string;
  roles: readonly string[];
  lead: boolean;
  available: boolean;
}

type RosterGetter = () => Record<string, RosterEntry>;

/** Maps actor capability namespaces to roster identity roles */
const ACTOR_ROLE_TO_ROSTER_ROLES: Record<ActorRole, string[]> = {
  'memory-curator': ['architect'],
  'repo-watcher': ['peer-reviewer', 'coder'],
  'health-monitor': ['architect', 'peer-reviewer'],
};

/**
 * Factory: creates a resolver function bound to a roster source.
 * Returns catId or null if no match.
 */
export function createActorResolver(getRoster: RosterGetter): (role: ActorRole, costTier: CostTier) => string | null {
  return (role: ActorRole, costTier: CostTier): string | null => {
    const roster = getRoster();
    const requiredRoles = ACTOR_ROLE_TO_ROSTER_ROLES[role];

    const candidates = Object.entries(roster)
      .filter(([, entry]) => {
        if (!entry.available) return false;
        return requiredRoles.some((r) => entry.roles.includes(r));
      })
      .map(([catId, entry]) => ({ catId, lead: entry.lead }));

    if (candidates.length === 0) return null;

    // costTier: deep → prefer lead, cheap → prefer non-lead
    candidates.sort((a, b) => {
      const aLead = a.lead ? 1 : 0;
      const bLead = b.lead ? 1 : 0;
      return costTier === 'deep' ? bLead - aLead : aLead - bLead;
    });

    return candidates[0].catId;
  };
}
