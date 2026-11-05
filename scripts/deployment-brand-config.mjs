import { isDeepStrictEqual } from 'node:util';
import { getRepositoryCoordinates } from './brand-dictionary-helper.mjs';

/** The dictionary owns display values; deployment JSON is its runtime projection. */
export function deriveDeploymentBrand(dictionary, edition) {
  const side = { home: 'home', opensource: 'public' }[edition];
  if (!side) throw new Error(`Unknown dictionary brand edition: ${edition}`);
  const term = (id) => {
    const value = dictionary.terms.find((entry) => entry.id === id)?.[side];
    if (!value) throw new Error(`Missing brand dictionary term: ${id}.${side}`);
    return value;
  };
  const primary = term('product.primary');
  const brand = {
    name: primary.canonical,
    displayName: primary.display,
    shortName: primary.short,
    hubName: term('product.hub').display,
    tagline: term('product.tagline').canonical,
  };
  for (const [key, value] of Object.entries(brand)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing brand dictionary field: ${key}`);
  }
  return brand;
}

export function refreshDeploymentBrands(input, dictionary) {
  const repositories = getRepositoryCoordinates(dictionary);
  return {
    ...input,
    profiles: Object.fromEntries(
      Object.entries(input.profiles).map(([edition, profile]) => [
        edition,
        {
          ...profile,
          brand: deriveDeploymentBrand(dictionary, edition),
          repositoryFullName: repositories[edition === 'opensource' ? 'public' : edition],
        },
      ]),
    ),
  };
}

export function assertDeploymentBrands(input, dictionary, requiredEdition) {
  if (input.activeProfile !== requiredEdition) throw new Error(`Expected ${requiredEdition} deployment profile`);
  if (!Object.hasOwn(input.profiles, requiredEdition)) throw new Error(`Missing ${requiredEdition} deployment profile`);
  const expected = refreshDeploymentBrands(input, dictionary);
  for (const [edition, profile] of Object.entries(input.profiles)) {
    if (!isDeepStrictEqual(profile.brand, expected.profiles[edition].brand)) {
      throw new Error(`Deployment brand ${edition} differs from its canonical dictionary`);
    }
    if (profile.repositoryFullName !== expected.profiles[edition].repositoryFullName) {
      throw new Error(`Deployment repository ${edition} differs from its canonical dictionary`);
    }
  }
}
