import { resolve } from 'node:path';

/**
 * `<projectRoot>/.cat-cafe/plugin-host`: the Host's own plugin state, and the parent of module
 * plugin data directories (F202 W2-3 h2). Host code builds this path only here.
 */
export function pluginHostRoot(projectRoot: string): string {
  return resolve(projectRoot, '.cat-cafe', 'plugin-host');
}

/**
 * Every entry the Host itself keeps in `pluginHostRoot`, and the single truth for which names a
 * plugin can never be given as its data directory. Host code names its files there only through
 * this table; a test holds it to that. Two things there are not listed on purpose: the git
 * installer's `.git-install-*` staging directories (a leading dot is never a valid data directory
 * name), and `personal-chrome-host`, which the ChatGPT Pro package takes over from the Host's F247
 * copy (ledger h2 ⑦).
 */
export const PLUGIN_HOST_ENTRIES = {
  inventory: 'inventory.json',
  broker: 'broker.json',
  packages: 'packages',
  resources: 'resources',
  media: 'media',
  mediaEntitlements: 'media-entitlements.json',
  outboundMedia: 'outbound-media.json',
  mediaStaging: 'media-staging.json',
  mediaPostProcessing: 'media-post-processing',
  quarantines: 'quarantines.json',
} as const;

const HOST_ENTRY_NAMES: ReadonlySet<string> = new Set(Object.values(PLUGIN_HOST_ENTRIES));

export function isHostPluginHostEntry(name: string): boolean {
  return HOST_ENTRY_NAMES.has(name);
}
