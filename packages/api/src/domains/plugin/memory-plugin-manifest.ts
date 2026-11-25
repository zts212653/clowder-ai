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
