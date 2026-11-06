import type { PluginPackageRecord } from '../host-inventory/types.js';

/** Immutable public archive that carries the beta.21 reply/command contract. */
export const PUBLISHED_COMPANION_V2 = {
  version: '0.1.0-alpha.13',
  packageDigest: 'sha512-ABEFM559peLzWfxlBKiCtYznDZ+olFdjfH/P7BZ6qeeykVCyUdtA7abF9jkrvzZefNvx3ghDk9n1IRgmP9lU/A==',
} as const;

/** Final registry release from source1351's B delivery; the digest is archive authority. */
export const PUBLISHED_COMPANION_PRESENTATION = {
  version: '0.1.0-alpha.24',
  packageDigest: 'sha512-TN23gstQt3AC79zddScxjr9q9ZPGaNn+ieGdrLvfm3Ju+ev1cBjH/z7US8pxP3bLLF6FbFYfPbFmogb9EeIxug==',
} as const;

/** Verified registry release for durable letters and bounded history; never a source-only candidate. */
export const PUBLISHED_COMPANION_LETTER = {
  version: '0.1.0-alpha.25',
  packageDigest: 'sha512-nAQbBlflHyfY08lzldO/nxEqbLvteXYT3e+rMxw/Lfq/2o8t01WH82aPLHrkyhxgvDe0IS7cfo0DCo30qow/wQ==',
} as const;

/**
 * Admitted public companion contract lines, oldest first. Every later line carries what the earlier modern lines do,
 * so Host checks ask for a capability (below) and a new line is one row here plus its archive row and validators.
 * The desktop kernel keeps the same table in `desktop/plugin-window/companion-contracts.cjs`; a test holds them equal.
 */
export const COMPANION_CONTRACT_LINES = [
  '0.1.0-beta.21',
  '0.1.0-beta.23',
  '0.1.0-beta.24',
  '0.1.0-beta.25',
  '0.1.0-beta.27',
  '0.1.0-beta.28',
  '0.1.0-beta.29',
  '0.3.3-candidate.0',
] as const;
export type CompanionContract = (typeof COMPANION_CONTRACT_LINES)[number];

/** The first contract line that carries each Host-visible capability. */
export const COMPANION_CAPABILITY_SINCE = {
  /** Published native state passthrough and call-scoped voice. */
  modern: '0.1.0-beta.23',
  /** `decisions.read` returns the unified decision page. */
  unifiedDecisions: '0.1.0-beta.24',
  /** The renderer accepts ball sizes below the published modern minimum. */
  smallBall: '0.1.0-beta.25',
  /** `state.meeting` and the presentation manifest reader. */
  presentation: '0.1.0-beta.27',
  /** Durable letters. */
  letter: '0.1.0-beta.28',
  /** `state.appAssist`, `app-assist.settle` and the `appAssistEnabled` setting. */
  appAssist: '0.1.0-beta.29',
  /** F335 交付三：`state.desk`, `desk.settle`, desk thumbnails and avatars. */
  desk: '0.3.3-candidate.0',
} as const satisfies Record<string, CompanionContract>;
export type CompanionCapability = keyof typeof COMPANION_CAPABILITY_SINCE;

export function isCompanionContract(value: unknown): value is CompanionContract {
  return typeof value === 'string' && (COMPANION_CONTRACT_LINES as readonly string[]).includes(value);
}

export function companionContractHas(contract: string | undefined, capability: CompanionCapability): boolean {
  if (!isCompanionContract(contract)) return false;
  return (
    COMPANION_CONTRACT_LINES.indexOf(contract) >=
    COMPANION_CONTRACT_LINES.indexOf(COMPANION_CAPABILITY_SINCE[capability])
  );
}

export interface CompanionArchiveContract {
  readonly version: string;
  readonly packageDigest: string;
  readonly contract: CompanionContract;
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
  {
    version: '0.1.0-alpha.20',
    packageDigest: 'sha512-R7KbX0EZAvE3Ll4S7d9lSrk5zIkBe8jnIHpdh82lE7v+mqoXtkDUifbXCYuEdMoDcEgkq/r49M9VBHnx9vtk6A==',
    contract: '0.1.0-beta.24',
  },
  {
    version: '0.1.0-alpha.21',
    packageDigest: 'sha512-YMfQcRHdn/F99FbfGDgbQlIHURA/RJvyh/4mNSVlK/dAa2Egx30WVD2YuWuClNH7mVypnK22q7LWoFKm48f4lA==',
    contract: '0.1.0-beta.25',
  },
  { ...PUBLISHED_COMPANION_PRESENTATION, contract: '0.1.0-beta.27' },
  { ...PUBLISHED_COMPANION_LETTER, contract: '0.1.0-beta.28' },
  {
    version: '0.1.0-alpha.26',
    packageDigest: 'sha512-bAyhY4Xbn5lzjaJtpFPRM7BhZtt5alycAxrVomLdv9WUAKVBBjA2u/EGDVpQEry1c6tqPLLfIqkLYXf0MKAclA==',
    contract: '0.1.0-beta.28',
  },
  {
    version: '0.1.0-alpha.27',
    packageDigest: 'sha512-bX/7PfYjM4j/GbidSoIESXZEqe3BEOCeWXqNaT5CfKOAF3gjVgEq98ZDnTgBzGZHmgo0y/+FlFNaRzh3kHKHiw==',
    contract: '0.1.0-beta.28',
  },
  {
    version: '0.1.0-alpha.28',
    packageDigest: 'sha512-5lb4orG5EQH16/2cR2cr2KOOCNogWn+xeageTT0DAd9Q0dCBgtLwp+iKb6nQ3W+kOiI4VU7bhODJLzSQiMiFRg==',
    contract: '0.1.0-beta.28',
  },
  {
    version: '0.1.0-alpha.29',
    packageDigest: 'sha512-qPZq2aGOwRCH6d0lSq5GQV8xwkTFABZqmfHRDjyKb9cd3E3Nht5UZEgC1mKEEKnlcLRuptdbKeEdxOQiBnRtVg==',
    contract: '0.1.0-beta.28',
  },
  {
    version: '0.1.0-alpha.30',
    packageDigest: 'sha512-9GHP5mRtPbkdRJ5InJ0I3Whih52PvCAWs2/ZLmjro1Tpaop893oBGsbXkCODGSooC4SkFqUDdIQ374v1AlAnUg==',
    contract: '0.1.0-beta.29',
  },
  {
    version: '0.1.0-alpha.31',
    packageDigest: 'sha512-awC/SV1MFVrzZvhS14tJuzQ8ZIS18V2O/W2ufJnE7oka6/oE086jZt4xwuFiz9HhNTcAs3HV4YuJSpsG5DkqXw==',
    contract: '0.1.0-beta.29',
  },
  {
    version: '0.1.0-alpha.32',
    packageDigest: 'sha512-zM9CLwI09/dqa4HM8ubSO+FejF2n307pF2DCiHd+QJ6O4YTuhW6s7FJX0qHxUISRvr872e/urZ/33f+Kk41PBg==',
    contract: '0.1.0-beta.29',
  },
  // F335 交付三：clowder-ai-plugins #188 (f21df559), npm `next`; the same SRI as catalog/candidate.json.
  {
    version: '0.1.0-alpha.37',
    packageDigest: 'sha512-xfxNnyl0Zg8qxCXInQdN5UJBn+uaKZF0exdDItNBCAputlke1Btfvk8GqdTCiYo0/2g/tmqAYegzOJhyZrRq/g==',
    contract: '0.3.3-candidate.0',
  },
];

export function isModernCompanionContract(contract: CompanionContract | undefined): boolean {
  return companionContractHas(contract, 'modern');
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

/** F335 交付三：the archive's state carries `desk` and its renderer settles it. */
export function companionSupportsDesk(contract: CompanionContract | undefined): boolean {
  return companionContractHas(contract, 'desk');
}
