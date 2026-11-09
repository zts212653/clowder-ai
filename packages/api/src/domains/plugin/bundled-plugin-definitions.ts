import { CHATGPT_DOT_PLUGIN_MANIFEST } from './chatgpt-dot-manifest.js';

/** A distribution selects packages here; generic admission never selects client names. */
export const BUNDLED_PLUGIN_DEFINITIONS = [
  {
    catalogId: 'chatgpt-dot',
    manifest: CHATGPT_DOT_PLUGIN_MANIFEST,
    prebuilt: { sha256: '8cec747364acbcfc7936a95f701335b7c4f457aef8db2f2789e81d9ebd2ae893' },
  },
];
