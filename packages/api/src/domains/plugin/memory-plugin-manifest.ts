import { validateManifest } from '@clowder-ai/plugin-contract';
import manifestJson from './bundled-packages/official.memory/0.1.0-candidate.22/manifest.json' with { type: 'json' };

const validated = validateManifest(manifestJson);
if (!validated.valid) {
  throw new TypeError(`Bundled memory manifest is invalid: ${validated.errors[0]?.message ?? 'unknown error'}`);
}

export const MEMORY_PLUGIN_MANIFEST = validated.manifest;
// This release archive ships only the Windows x64 Node ABI 137 binding.
export const supportsBundledMemory =
  process.platform === 'win32' && process.arch === 'x64' && process.versions.modules === '137';

export const BUNDLED_MEMORY_DEFINITIONS = supportsBundledMemory
  ? [
      {
        catalogId: MEMORY_PLUGIN_MANIFEST.pluginId,
        manifest: MEMORY_PLUGIN_MANIFEST,
        prebuilt: { sha256: 'fea89138cc7735b0ed8e74f6f428d3d67ae48d585af3871c96221556a1c37439' },
      },
    ]
  : [];
