import {
  type CatBreed,
  type CatCafeConfig,
  type CatConfig,
  type CatVariant,
  hasAuthoredMemberIdentityValue,
} from '@cat-cafe/shared';

// Provenance travels with this parsed snapshot; it is never another persisted catalog or a disk reread.
const authoredCatalogs = new WeakMap<CatCafeConfig, CatCafeConfig | null>();
export function captureMemberIdentitySources(config: CatCafeConfig, authored: CatCafeConfig | null) {
  authoredCatalogs.set(config, authored);
  return config;
}

export function projectMemberIdentitySources(config: CatCafeConfig, breed: CatBreed, variant: CatVariant) {
  const authored = authoredCatalogs.has(config) ? authoredCatalogs.get(config) : config;
  const ownBreed = authored?.breeds.find((entry) => entry.id === breed.id);
  const ownVariant = ownBreed?.variants?.find((entry) => entry.id === variant.id);
  const defaultVariant = ownBreed?.variants?.find((entry) => entry.id === breed.defaultVariantId);
  const sources: NonNullable<CatConfig['identitySources']> = Object.fromEntries(
    [
      'name',
      'displayName',
      'nickname',
      'roleDescription',
      'personality',
      'teamStrengths',
      'caution',
      'restrictions',
    ].map((field) => {
      // Follow the resolved value chain before assigning authored provenance.
      // A template variant's own value wins over an edited breed/default too.
      const key =
        field === 'name' && variant.name === undefined && variant.displayName !== undefined
          ? 'displayName'
          : (field as keyof CatVariant);
      let source = 'template';
      if (variant[key] !== undefined) {
        if (hasAuthoredMemberIdentityValue(field, ownVariant?.[key])) source = 'variant';
      } else if (field === 'personality') {
        if (defaultVariant?.personality !== undefined) source = 'default_variant';
      } else if (hasAuthoredMemberIdentityValue(field, ownBreed?.[field as keyof CatBreed])) {
        source = 'breed';
      }
      return [field, source];
    }),
  );
  return sources;
}
