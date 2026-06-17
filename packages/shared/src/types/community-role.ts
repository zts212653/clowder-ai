/**
 * Community Role Registry Types (F168 Phase C — Narrator + Role Registry)
 *
 * The community-ops engine routes work by ROLE, never by cat name. A RoleResolver
 * (injected, deployment-owned) maps an abstract CommunityRole → a concrete RoleExecutor
 * (which cat, which model, which prompt). This decouples the engine from the roster
 * (终态设计 §4) and keeps "who narrates" a config concern, not a code constant (INV-6).
 *
 * Invariants anchored here:
 *   - INV-4: CommunityRole is a CLOSED set; unknown role → fail-closed (resolve returns null).
 *            isCommunityRole is the runtime membership primitive enabling fail-closed resolution.
 *   - INV-2: RoleCapability deliberately EXCLUDES 'code' / 'merge' / 'worktree'. Community roles
 *            (narrator/case-owner/reconciler) triage, recommend routes, and reply — they never
 *            write code. The type makes the capability ceiling unrepresentable, not just unenforced.
 */

/** The closed set of engine roles. Single runtime source for the CommunityRole union. */
export const COMMUNITY_ROLES = ['narrator', 'case-owner', 'reconciler'] as const;

/** Abstract role the community engine resolves to an executor (never a cat name). */
export type CommunityRole = (typeof COMMUNITY_ROLES)[number];

/** Fail-closed membership guard (INV-4). Unknown / malformed input → false, never throws. */
export function isCommunityRole(value: unknown): value is CommunityRole {
  return typeof value === 'string' && (COMMUNITY_ROLES as readonly string[]).includes(value);
}

/**
 * Capabilities a community role may hold. Deliberately a closed set that EXCLUDES
 * code/merge/worktree (INV-2): community roles never touch the codebase. The omission is
 * structural — there is no RoleCapability value that grants code/merge/worktree power.
 */
export const ROLE_CAPABILITIES = ['triage', 'route-recommend', 'public-reply'] as const;

/** Capability a CommunityRole executor may be granted. */
export type RoleCapability = (typeof ROLE_CAPABILITIES)[number];

/** Membership guard for RoleCapability. Unknown / malformed input → false, never throws. */
export function isRoleCapability(value: unknown): value is RoleCapability {
  return typeof value === 'string' && (ROLE_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Concrete binding a role resolves to: which cat, which model, which prompt template,
 * and the (capped) capabilities it may exercise. Produced by deployment config, consumed
 * by the engine via RoleResolver — the engine never constructs this from cat-name constants.
 */
export interface RoleExecutor {
  readonly catId: string;
  readonly model: string;
  readonly promptTemplateId: string;
  readonly capabilities: readonly RoleCapability[];
}

/**
 * The engine's ONLY dependency on the roster. resolve(role) → executor, or null when the
 * role is unknown (INV-4) or unbound / unavailable (INV-5) — fail-closed, never a silent
 * default. Implemented by deployment (家里 = roster binding; 别人家 = their catalog). See C1.2.
 */
export interface RoleResolver {
  resolve(role: CommunityRole): RoleExecutor | null;
}
