import type { CatConfig } from './types/cat.js';

/** Pure views of the existing resolved catalog; no second persistence model. */
export function projectMemberProfiles(config: CatConfig) {
  const {
    id,
    name,
    displayName,
    nickname,
    avatar,
    banner,
    color,
    mentionPatterns,
    roleDescription,
    personality,
    breedId,
    relationshipKey,
    variantLabel,
    isDefaultVariant,
    breedDisplayName,
    teamStrengths,
    caution,
    restrictions,
    strengths,
    voiceConfig,
    identitySources,
    ...executionProfile
  } = config;
  return {
    roleProfile: {
      id,
      name,
      displayName,
      nickname,
      avatar,
      banner,
      color,
      mentionPatterns,
      roleDescription,
      personality,
      breedId,
      relationshipKey,
      variantLabel,
      isDefaultVariant,
      breedDisplayName,
      teamStrengths,
      caution,
      restrictions,
      strengths,
      voiceConfig,
      identitySources,
    },
    executionProfile,
  };
}

export type RoleProfile = Readonly<ReturnType<typeof projectMemberProfiles>['roleProfile']>;
export type ExecutionProfile = Readonly<ReturnType<typeof projectMemberProfiles>['executionProfile']>;
