export type SkillMountPathInput = Record<string, readonly string[]>;

export function normalizeSkillMountPathPolicy(input?: SkillMountPathInput): Map<string, Set<string>> {
  const policy = new Map<string, Set<string>>();
  if (!input) return policy;
  for (const [skillName, mountPointIds] of Object.entries(input)) {
    policy.set(skillName, new Set(mountPointIds));
  }
  return policy;
}

export function skillMountPointIds(
  policy: ReadonlyMap<string, ReadonlySet<string>>,
  skillName: string,
): ReadonlySet<string> | undefined {
  return policy.get(skillName);
}

export function skillAllowsMountPoint(
  policy: ReadonlyMap<string, ReadonlySet<string>>,
  skillName: string,
  mountPointId: string,
): boolean {
  const allowed = skillMountPointIds(policy, skillName);
  return !allowed || allowed.has(mountPointId);
}

export function canonicalSkillMountPathPolicy(policy: ReadonlyMap<string, ReadonlySet<string>>): object[] {
  return [...policy.entries()]
    .map(([skill, mountPoints]) => ({ skill, mountPoints: [...mountPoints].sort() }))
    .sort((a, b) => a.skill.localeCompare(b.skill));
}
