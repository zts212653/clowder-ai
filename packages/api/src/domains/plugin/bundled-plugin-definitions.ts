import { CHATGPT_DOT_PLUGIN_MANIFEST } from './chatgpt-dot-manifest.js';

/** A distribution selects packages here; generic admission never selects client names. */
export const BUNDLED_PLUGIN_DEFINITIONS = [{ catalogId: 'chatgpt-dot', manifest: CHATGPT_DOT_PLUGIN_MANIFEST }];
