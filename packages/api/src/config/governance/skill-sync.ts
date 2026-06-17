/**
 * Skill sync utilities — shared helpers for skill name validation
 * and mount path resolution.
 *
 * F228: The main sync orchestration moved to skill-sync-engine.ts (syncProject).
 * This file retains only pure utilities consumed by multiple modules.
 */

// ────────── Skill name validation ──────────

const VALID_SKILL_NAME = /^[a-z][a-z0-9-]*$/;

/** Non-throwing check: true if name matches skill naming rules. */
export function isValidSkillName(name: string): boolean {
  return VALID_SKILL_NAME.test(name);
}

/** Safe skill name: lowercase letters, digits, hyphens. No path separators, dots-only, or absolute paths. */
export function validateSkillName(name: string): void {
  if (!isValidSkillName(name)) {
    throw new Error(`Invalid skill name: "${name}". Must match ${VALID_SKILL_NAME}.`);
  }
}

// ────────── Mount path resolution ──────────

/**
 * Resolve effective mount paths for a skill.
 * Project-local mountPaths is authoritative when present;
 * global mountPaths is a cascade default only.
 */
export function resolveEffectiveSkillMountPaths(
  projectMountPaths?: readonly string[],
  globalMountPaths?: readonly string[],
): string[] | undefined {
  if (projectMountPaths) return [...projectMountPaths];
  if (globalMountPaths) return [...globalMountPaths];
  return undefined;
}
