import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Installation identity, URLs, icons and colors belong to the manifest itself. */
export function projectBrandManifest(manifest, brand) {
  return { ...manifest, name: brand.displayName, short_name: brand.shortName, description: brand.tagline };
}

export function syncBrandManifest(webRoot, brand) {
  const path = resolve(webRoot, 'public/manifest.json');
  const before = readFileSync(path, 'utf8');
  const after = `${JSON.stringify(projectBrandManifest(JSON.parse(before), brand), null, 2)}\n`;
  if (before === after) return false;
  writeFileSync(path, after);
  return true;
}
