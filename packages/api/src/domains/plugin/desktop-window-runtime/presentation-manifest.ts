import { type PluginManifest, validateManifest } from '@clowder-ai/plugin-contract';
import { validateManifest as validateDeskManifest } from '@clowder-ai/plugin-contract-033c0';
import { validateManifest as validatePresentationManifest } from '@clowder-ai/plugin-contract-beta27';
import { validateManifest as validateLetterManifest } from '@clowder-ai/plugin-contract-beta28';
import { validateManifest as validateAppAssistManifest } from '@clowder-ai/plugin-contract-beta29';
import { desktopWindowContribution } from './admission.js';
import { COMPANION_ARCHIVE_CONTRACTS, type CompanionContract } from './published-companion-v2.js';

type PublishedManifestReader = (value: unknown) => { valid: boolean; manifest?: unknown };

/** The published manifest schema and the exact bridge literal each presentation-era contract line delivers. */
const PUBLISHED_MANIFESTS: Partial<
  Record<CompanionContract, { readonly validate: PublishedManifestReader; readonly bridgeVersion: string }>
> = {
  '0.1.0-beta.27': { validate: validatePresentationManifest, bridgeVersion: '1.4.0' },
  '0.1.0-beta.28': { validate: validateLetterManifest, bridgeVersion: '1.5.0' },
  '0.1.0-beta.29': { validate: validateAppAssistManifest, bridgeVersion: '1.6.0' },
  '0.3.3-candidate.0': { validate: validateDeskManifest, bridgeVersion: '1.7.0' },
};

/** The package manifest as the contract reads it; a plugin's console is its console/pdl.yaml, not the manifest.
 * Existing companion bridge admission and exact archive SRI verification stay unchanged.
 */
export function validateHostPluginManifest(value: unknown): ReturnType<typeof validateManifest> {
  return validateBaseManifest(value);
}

function validateBaseManifest(value: unknown): ReturnType<typeof validateManifest> {
  let legacy = validateManifest(value);
  const version = value && typeof value === 'object' && 'version' in value ? value.version : undefined;
  // A newer general schema must not widen the Host's pinned desktop bridge ABI. A version without a
  // pinned release is a local build: the current contract reads it, and the runtime decides whether it may run.
  if (legacy.valid) {
    if (
      !legacy.manifest.contributions?.some((c) => c.type === 'desktop-window' && c.bridgeVersion === '1.7.0') ||
      !COMPANION_ARCHIVE_CONTRACTS.some((row) => row.version === version)
    )
      return legacy;
    legacy = {
      valid: false,
      errors: [
        {
          instancePath: '/contributions',
          schemaPath: '#/desktop-window/bridgeVersion',
          keyword: 'enum',
          message: 'Bridge 1.7.0 requires a pinned companion release',
        },
      ],
    };
  }
  const release = COMPANION_ARCHIVE_CONTRACTS.find(
    (row) => row.version === version && PUBLISHED_MANIFESTS[row.contract] !== undefined,
  );
  const reader = release && PUBLISHED_MANIFESTS[release.contract];
  if (!release || !reader) return legacy;
  const published = reader.validate(value);
  const candidate = published.manifest as PluginManifest | undefined;
  if (
    !published.valid ||
    !candidate ||
    candidate.pluginId !== 'official.companion' ||
    candidate.version !== release.version
  )
    return legacy;
  // The Host's old structural type differs only at bridgeVersion here. Do not
  // rewrite manifest bytes or infer archive authority from schema compatibility.
  const body = desktopWindowContribution(candidate);
  if (!body || String(body.bridgeVersion) !== reader.bridgeVersion) return legacy;
  return { valid: true, manifest: candidate, errors: [] };
}
