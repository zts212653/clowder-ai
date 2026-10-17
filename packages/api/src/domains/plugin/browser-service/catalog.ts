import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserServiceContribution } from '@clowder-ai/plugin-contract';
import type { ModuleBrowserServiceActivationInput } from '../host-surface/plugin-browser-service-host.js';
import { loadRetainedBrowserAssets } from './retained-assets.js';
import { BrowserServiceTransportError } from './transport-policy.js';

// Resolves the same shipped build from src/ (tsx development) and dist/ (compiled runtime).
const root = fileURLToPath(new URL('../../../../dist/browser-assets/', import.meta.url));
function unavailable(): never {
  throw new BrowserServiceTransportError('BROWSER_SERVICE_UNAVAILABLE');
}

/** The generated Host catalog binds a product/declaration to the exact retained asset manifest. */
export async function resolveRetainedBrowserAssets(
  input: ModuleBrowserServiceActivationInput,
  contribution: BrowserServiceContribution,
) {
  const filename = path.join(root, 'catalog.json');
  const info = await stat(filename);
  if (!info.isFile() || info.size > 65536) unavailable();
  const catalog = JSON.parse(await readFile(filename, 'utf8'));
  if (catalog?.version !== 1 || !Array.isArray(catalog.entries) || catalog.entries.length > 32) unavailable();
  const matching = catalog.entries.filter(
    (entry: { pluginId?: string; contributionId?: string }) =>
      entry.pluginId === input.packageRecord.pluginId && entry.contributionId === contribution.id,
  );
  if (matching.length !== 1) unavailable();
  const entry = matching[0];
  if (
    typeof entry.directory !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.directory) ||
    typeof entry.clientBuildId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.assetDigest)
  )
    unavailable();
  return loadRetainedBrowserAssets(path.join(root, entry.directory), {
    clientBuildId: entry.clientBuildId,
    assetDigest: entry.assetDigest,
  });
}
