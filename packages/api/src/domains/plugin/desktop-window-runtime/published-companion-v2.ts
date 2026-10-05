import type { PluginPackageRecord } from '../host-inventory/types.js';

/** Immutable public archive that carries the beta.21 reply/command contract. */
export const PUBLISHED_COMPANION_V2 = {
  version: '0.1.0-alpha.13',
  packageDigest: 'sha512-ABEFM559peLzWfxlBKiCtYznDZ+olFdjfH/P7BZ6qeeykVCyUdtA7abF9jkrvzZefNvx3ghDk9n1IRgmP9lU/A==',
} as const;

export interface CompanionArchiveContract {
  readonly version: string;
  readonly packageDigest: string;
  readonly contract: '0.1.0-beta.21' | '0.1.0-beta.23' | '0.1.0-beta.24';
}

/** Host-owned archive catalog, never negotiated by bridgeVersion or renderer input. */
export const COMPANION_ARCHIVE_CONTRACTS: readonly CompanionArchiveContract[] = [
  { ...PUBLISHED_COMPANION_V2, contract: '0.1.0-beta.21' },
  {
    version: '0.1.0-alpha.14',
    packageDigest: 'sha512-aAJpJMjU20QtHaVY40LnJYHCVkJdqtJd1+3wGPjLgK/7sF9wxObc6y8udJKgXFOC0RqPy4MlQM35tCbE03YkAA==',
    contract: '0.1.0-beta.23',
  },
  {
    version: '0.1.0-alpha.15',
    packageDigest: 'sha512-jbJNGzP5I2XpnlL38FA9xb+bFyfUoL+TojPaOdoKZ9IzPxeZynJoa1ti10HQL2Ajw/nutDy22OC7wxM9EJBY1w==',
    contract: '0.1.0-beta.24',
  },
  {
    version: '0.1.0-alpha.19',
    packageDigest: 'sha512-8z1dZ4qLtSMBw9vEwpXY4xDOfO2tjD+SXeY5QkusMQRu1/vIErf9y5osR1KjT5UdsHkaosS/H48XoJxW+iD/FA==',
    contract: '0.1.0-beta.24',
  },
];

export function isModernCompanionContract(contract: CompanionArchiveContract['contract'] | undefined): boolean {
  return contract === '0.1.0-beta.23' || contract === '0.1.0-beta.24';
}

export function resolveCompanionArchiveContract(
  pkg: Pick<PluginPackageRecord, 'pluginId' | 'version' | 'packageDigest'>,
  archives: readonly CompanionArchiveContract[] = COMPANION_ARCHIVE_CONTRACTS,
): CompanionArchiveContract['contract'] | undefined {
  if (pkg.pluginId !== 'official.companion') return undefined;
  return archives.find((row) => row.version === pkg.version && row.packageDigest === pkg.packageDigest)?.contract;
}

export function hasPublishedCompanionV2(
  pkg: Pick<PluginPackageRecord, 'pluginId' | 'version' | 'packageDigest'>,
): boolean {
  return resolveCompanionArchiveContract(pkg) === '0.1.0-beta.21';
}
