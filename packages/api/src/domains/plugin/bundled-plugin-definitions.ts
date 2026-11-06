import { CHATGPT_DOT_PLUGIN_MANIFEST } from './chatgpt-dot-manifest.js';

/** A distribution selects packages here; generic admission never selects client names. */
export const BUNDLED_PLUGIN_DEFINITIONS = [
  {
    catalogId: 'chatgpt-dot',
    manifest: CHATGPT_DOT_PLUGIN_MANIFEST,
    prebuilt: { sha256: '07054ab90a9a27dd1415ce631fe3ca0e63b17bf36ef69a34f5dcb1f5ff2e4bec' },
  },
];
