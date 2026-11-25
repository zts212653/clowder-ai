import { CHATGPT_DOT_PLUGIN_MANIFEST } from './chatgpt-dot-manifest.js';
import { MEMORY_PLUGIN_MANIFEST, supportsBundledMemory } from './memory-plugin-manifest.js';

/** A distribution selects packages here; generic admission never selects client names. */
export const BUNDLED_PLUGIN_DEFINITIONS = [
  {
    catalogId: 'chatgpt-dot',
    manifest: CHATGPT_DOT_PLUGIN_MANIFEST,
    prebuilt: { sha256: '4c31b455e4243bf93d7d8d6edddd28a68f62144fa6ecfae75870545847bef0c9' },
  },
  ...(supportsBundledMemory
    ? [
        {
          catalogId: MEMORY_PLUGIN_MANIFEST.pluginId,
          manifest: MEMORY_PLUGIN_MANIFEST,
          prebuilt: { sha256: 'fea89138cc7735b0ed8e74f6f428d3d67ae48d585af3871c96221556a1c37439' },
        },
      ]
    : []),
];
