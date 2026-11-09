import { validateManifest } from '@clowder-ai/plugin-contract';
import manifestJson from './bundled-packages/chatgpt-dot/0.2.0-alpha.34/manifest.json' with { type: 'json' };

const validated = validateManifest(manifestJson);
if (!validated.valid) {
  throw new TypeError(`Bundled plugin manifest is invalid: ${validated.errors[0]?.message ?? 'unknown error'}`);
}

/** Catalog projection of the manifest generated beside the exact bundled archive. */
export const CHATGPT_DOT_PLUGIN_MANIFEST = validated.manifest;
export const CHATGPT_DOT_PLUGIN_ID = CHATGPT_DOT_PLUGIN_MANIFEST.pluginId;
