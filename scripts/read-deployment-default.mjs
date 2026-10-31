#!/usr/bin/env node
// Node 24 can load this source module before any package artifacts exist.
import { deploymentDefaults, resolveStartupDefaults } from '../packages/shared/src/deployment-defaults.ts';

const [field, ...extra] = process.argv.slice(2);
if (field === '--startup-profile') {
  const [name, platform, format] = extra;
  if (![2, 3].includes(extra.length) || (format !== undefined && format !== '--shell'))
    throw new Error('Usage: --startup-profile <name> <posix|win32> [--shell]');
  const defaults = resolveStartupDefaults(name, platform);
  console.log(
    format === '--shell'
      ? Object.entries(defaults)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n')
      : JSON.stringify(defaults),
  );
  process.exit(0);
}
const allowed = new Set([
  'apiPort',
  'webPort',
  'envRegistryFrontendPort',
  'apiBaseUrl',
  'apiLoopbackUrl',
  'frontendBaseUrl',
  'roadmapPath',
  'repositoryFullName',
  'repositoryUrl',
  'brand.name',
  'brand.displayName',
  '--json',
]);
if (!allowed.has(field) || extra.length) throw new Error('Usage: read-deployment-default <deployment-field|--json>');
console.log(
  field === '--json'
    ? JSON.stringify(deploymentDefaults)
    : field.startsWith('brand.')
      ? deploymentDefaults.brand[field.slice(6)]
      : deploymentDefaults[field],
);
