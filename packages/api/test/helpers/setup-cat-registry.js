/**
 * Auto-populate catRegistry for tests.
 *
 * Loads breeds from cat-template.json directly (no catalog overlay) so the
 * registry is deterministic regardless of stale .cat-cafe/cat-catalog.json
 * files that other tests may create during their run.
 *
 * Also redirects CAT_TEMPLATE_PATH to an isolated temp copy so that
 * getCachedConfig() → loadCatConfig() (used by getRoster(), getReviewPolicy(),
 * etc.) never picks up catalog artifacts from other test files.
 *
 * Usage: import './helpers/setup-cat-registry.js';
 *
 * See also: packages/api/package.json `--import $(pwd)/...` for Node loader usage.
 */

import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../../../cat-template.json');

// Redirect CAT_TEMPLATE_PATH to a temp directory that has no .cat-cafe/ subdir.
// This ensures loadCatConfig() (called by getCachedConfig → getRoster, etc.)
// never finds stale cat-catalog.json files created by tests like
// cat-account-binding, even after _resetCachedConfig() clears the cache.
const tmpDir = resolve(process.env.TMPDIR ?? '/tmp', `cat-cafe-test-template-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });
cpSync(TEMPLATE_PATH, resolve(tmpDir, 'cat-template.json'));
process.env.CAT_TEMPLATE_PATH = resolve(tmpDir, 'cat-template.json');

async function registerAllCats() {
  const { loadCatConfig, toAllCatConfigs } = await import('../../dist/config/cat-config-loader.js');
  // Pass explicit path → reads ONLY cat-template.json, skips catalog overlay.
  const allConfigs = toAllCatConfigs(loadCatConfig(TEMPLATE_PATH));
  for (const [id, config] of Object.entries(allConfigs)) {
    if (!catRegistry.has(id)) {
      catRegistry.register(id, config);
    }
  }
}

await registerAllCats();
