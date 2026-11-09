import { CHATGPT_DOT_PLUGIN_MANIFEST } from './chatgpt-dot-manifest.js';

/** A distribution selects packages here; generic admission never selects client names. */
export const BUNDLED_PLUGIN_DEFINITIONS = [
  {
    catalogId: 'chatgpt-dot',
    manifest: CHATGPT_DOT_PLUGIN_MANIFEST,
    prebuilt: { sha256: '2cdba275dfbf17f2c35d90830011637091ccf7212c9cdf0389842403278b143c' },
  },
];
