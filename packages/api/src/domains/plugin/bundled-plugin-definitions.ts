import { CHATGPT_DOT_PLUGIN_MANIFEST } from './chatgpt-dot-manifest.js';

/** A distribution selects packages here; generic admission never selects client names. */
export const BUNDLED_PLUGIN_DEFINITIONS = [
  {
    catalogId: 'chatgpt-dot',
    manifest: CHATGPT_DOT_PLUGIN_MANIFEST,
    prebuilt: { sha256: '6bc8a58ba1a6c3bd46f534e5f913c129e2a1d84a65adcec3ee3eb5a8865987f6' },
  },
];
