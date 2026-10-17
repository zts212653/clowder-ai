import { createRequire } from 'node:module';

// Deliberately narrow adapter for the API's direct, exactly locked dependency.
// No npm internals, hoisted dependency or includePrerelease override is used.
const semver = createRequire(import.meta.url)('semver') as {
  valid(version: string): string | null;
  validRange(range: string): string | null;
  satisfies(version: string, range: string): boolean;
};
export const sourceSemver = semver;
