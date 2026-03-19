import type { ProfileItem } from './hub-provider-profiles.types';

function cloneProfile(
  profile: ProfileItem,
  override: Pick<ProfileItem, 'id' | 'provider' | 'displayName' | 'name'> & {
    oauthLikeClient: NonNullable<ProfileItem['oauthLikeClient']>;
  },
): ProfileItem {
  return {
    ...profile,
    id: override.id,
    provider: override.provider,
    displayName: override.displayName,
    name: override.name,
    targetProfileId: profile.id,
    oauthLikeClient: override.oauthLikeClient,
  };
}

export function expandProviderProfiles(profiles: ProfileItem[]): ProfileItem[] {
  const expanded: ProfileItem[] = [];
  for (const profile of profiles) {
    expanded.push(profile);
    if (profile.id === 'claude-oauth') {
      expanded.push(
        cloneProfile(profile, {
          id: 'opencode-client-auth',
          provider: 'opencode-client-auth',
          displayName: 'OpenCode (client-auth)',
          name: 'OpenCode (client-auth)',
          oauthLikeClient: 'opencode',
        }),
      );
    }
    if (profile.id === 'codex-oauth') {
      expanded.push(
        cloneProfile(profile, {
          id: 'dare-client-auth',
          provider: 'dare-client-auth',
          displayName: 'Dare (client-auth)',
          name: 'Dare (client-auth)',
          oauthLikeClient: 'dare',
        }),
      );
    }
  }
  return expanded;
}

export function resolveProfileActionId(profile: ProfileItem): string {
  return profile.targetProfileId ?? profile.id;
}

export function isOAuthLikeBuiltin(profile: ProfileItem): boolean {
  return Boolean(profile.oauthLikeClient);
}
