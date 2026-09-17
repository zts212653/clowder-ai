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

export interface ActorResolutionPolicy {
  isScarce(catId: string): boolean;
}

function requiredRoles(role: ActorRole, costTier: CostTier, policy?: ActorResolutionPolicy): string[] {
  if (role === 'memory-curator' && costTier === 'cheap' && policy) {
    return ['memory-spike', 'assistant', 'thinker', 'reasoning', 'coder', 'architect'];
  }
  return ACTOR_ROLE_TO_ROSTER_ROLES[role];
}

/**
 * Factory: creates a resolver function bound to a roster source.
 * Returns catId or null if no match.
 */
export function createActorResolver(
  getRoster: RosterGetter,
  policy?: ActorResolutionPolicy,
): (role: ActorRole, costTier: CostTier) => string | null {
  return (role: ActorRole, costTier: CostTier): string | null => {
    const roster = getRoster();
    const acceptedRoles = requiredRoles(role, costTier, policy);

    const candidates = Object.entries(roster)
      .filter(([catId, entry]) => {
        if (!entry.available) return false;
        if (role === 'memory-curator' && costTier === 'cheap' && policy?.isScarce(catId)) return false;
        return acceptedRoles.some((r) => entry.roles.includes(r));
      })
      .map(([catId, entry]) => ({
        catId,
        lead: entry.lead,
        roleRank: Math.min(
          ...entry.roles.map((entryRole) => acceptedRoles.indexOf(entryRole)).filter((rank) => rank >= 0),
        ),
      }));

    if (candidates.length === 0) return null;

    // costTier: deep → prefer lead, cheap → prefer non-lead
    candidates.sort((a, b) => {
      const aLead = a.lead ? 1 : 0;
      const bLead = b.lead ? 1 : 0;
      const leadOrder = costTier === 'deep' ? bLead - aLead : aLead - bLead;
      if (leadOrder !== 0) return leadOrder;
      if (a.roleRank !== b.roleRank) return a.roleRank - b.roleRank;
      return a.catId.localeCompare(b.catId);
    });

    return candidates[0].catId;
  };
}
