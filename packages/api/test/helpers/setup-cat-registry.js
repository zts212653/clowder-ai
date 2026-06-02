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

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { createIsolatedTemplateRoot } from './isolated-template-root.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../../../cat-template.json');

// Redirect CAT_TEMPLATE_PATH to a UNIQUE, collision-free temp root (mkdtemp) with no
// .cat-cafe/ overlay, so loadCatConfig() (called by getCachedConfig → getRoster, etc.)
// never inherits a stale breeds:[] cat-catalog.json that a pid-reused prior process left
// behind (its app boot wrote one via bootstrapDefaultCatCatalog). The previous
// `cat-cafe-test-template-${process.pid}` name was not unique across time → pid reuse
// leaked an empty roster into unrelated tests. See isolated-template-root.js for the
// full F211 #2013 follow-up rationale.
const { templatePath, cleanup } = createIsolatedTemplateRoot(process.env.TMPDIR ?? '/tmp', TEMPLATE_PATH);
process.on('exit', cleanup);
process.env.CAT_TEMPLATE_PATH = templatePath;

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
