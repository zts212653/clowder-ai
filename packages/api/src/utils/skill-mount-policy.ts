export type SkillMountPathInput = Record<string, readonly string[]>;

export function normalizeSkillMountPathPolicy(input?: SkillMountPathInput): Map<string, Set<string>> {
  const policy = new Map<string, Set<string>>();
  if (!input) return policy;
  for (const [skillName, providerIds] of Object.entries(input)) {
    policy.set(skillName, new Set(providerIds));
  }
  return policy;
}

export function skillMountProviderIds(
  policy: ReadonlyMap<string, ReadonlySet<string>>,
  skillName: string,
): ReadonlySet<string> | undefined {
  return policy.get(skillName);
}

export function skillAllowsMountProvider(
  policy: ReadonlyMap<string, ReadonlySet<string>>,
  skillName: string,
  providerId: string,
): boolean {
  const allowed = skillMountProviderIds(policy, skillName);
  return !allowed || allowed.has(providerId);
}

export function canonicalSkillMountPathPolicy(policy: ReadonlyMap<string, ReadonlySet<string>>): object[] {
  return [...policy.entries()]
    .map(([skill, providers]) => ({ skill, providers: [...providers].sort() }))
    .sort((a, b) => a.skill.localeCompare(b.skill));
}
