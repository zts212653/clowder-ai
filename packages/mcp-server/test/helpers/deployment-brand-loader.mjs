import { readFile } from 'node:fs/promises';

// Replace only the selected JSON data in a fresh child. Production modules,
// handlers, SDK registration and validators are loaded without substitution.
export async function load(url, context, nextLoad) {
  if (
    url.endsWith('/deployment-profiles.json') &&
    (process.env.TEST_DEPLOYMENT_BRAND || process.env.TEST_DEPLOYMENT_REPOSITORY || process.env.TEST_DEPLOYMENT_PROFILE)
  ) {
    const profiles = JSON.parse(await readFile(new URL(url), 'utf8'));
    if (process.env.TEST_DEPLOYMENT_PROFILE) {
      const selected = process.env.TEST_DEPLOYMENT_PROFILE;
      if (!profiles.profiles[selected]) throw new Error(`Missing test deployment profile: ${selected}`);
      profiles.activeProfile = selected;
      profiles.profiles = { [selected]: profiles.profiles[selected] };
    }
    if (process.env.TEST_DEPLOYMENT_BRAND)
      profiles.profiles[profiles.activeProfile].brand = JSON.parse(process.env.TEST_DEPLOYMENT_BRAND);
    if (process.env.TEST_DEPLOYMENT_REPOSITORY)
      profiles.profiles[profiles.activeProfile].repositoryFullName = process.env.TEST_DEPLOYMENT_REPOSITORY;
    return { format: 'json', source: JSON.stringify(profiles), shortCircuit: true };
  }
  return nextLoad(url, context);
}
