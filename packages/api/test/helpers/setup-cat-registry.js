/**
 * Auto-populate catRegistry for tests.
 *
 * Prefer the real cat-config.json expansion so route tests see the same
 * variant roster as runtime (gpt52/sonnet/spark/etc.), then fall back
 * to shared static defaults if config loading is unavailable.
 *
 * Usage: import './helpers/setup-cat-registry.js';
 */

import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';

async function registerAllCats() {
  try {
    const { loadCatConfig, toAllCatConfigs } = await import('../../dist/config/cat-config-loader.js');
    const allConfigs = toAllCatConfigs(loadCatConfig());
    for (const [id, config] of Object.entries(allConfigs)) {
      if (!catRegistry.has(id)) {
        catRegistry.register(id, config);
      }
    }
    return;
  } catch {
    // Best-effort fallback for contexts without built dist/config support.
  }

  for (const [id, config] of Object.entries(CAT_CONFIGS)) {
    if (!catRegistry.has(id)) {
      catRegistry.register(id, config);
    }
  }
}

await registerAllCats();
