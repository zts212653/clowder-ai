import type { NativePartner } from './native-onboarding';

/** Select a pending legacy key without treating roster similarity as a creation receipt. */
export function legacyCreationKey(previous: NativePartner, savedPartners: NativePartner[]): string | undefined {
  const shared = legacySharedKey(previous, savedPartners);
  if (!shared) return previous.creationRequestKey ?? previous.id;
  if (previous.creationRequestKey && previous.creationRequestKey !== shared) return previous.creationRequestKey;
  // A roster member, even with the same ID and descriptor, may belong to another journey.
  // Only replaying the original persisted body/key can establish request ownership.
  // The successful POST in useNativeOnboarding splits the remaining shared keys.
  return shared;
}

export function legacySharedKey(previous: NativePartner, partners: NativePartner[]): string | undefined {
  if (previous.legacySharedRequestKey) return previous.legacySharedRequestKey;
  if (previous.creationRequestKey) return undefined;
  return partners.filter((p) => !p.creationRequestKey && p.id === previous.id).length > 1 ? previous.id : undefined;
}
