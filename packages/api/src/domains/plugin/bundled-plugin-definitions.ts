import { CHATGPT_DOT_PLUGIN_MANIFEST } from './chatgpt-dot-manifest.js';

/** A distribution selects packages here; generic admission never selects client names. */
export const BUNDLED_PLUGIN_DEFINITIONS = [
  {
    catalogId: 'chatgpt-dot',
    manifest: CHATGPT_DOT_PLUGIN_MANIFEST,
    prebuilt: { sha256: '14b4d67f12c21350dcb2307d93ede8b74b4c00198303fd4b788ac58a1a43fd7d' },
  },
];
