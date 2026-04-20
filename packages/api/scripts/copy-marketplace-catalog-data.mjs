import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const packageDir = path.resolve(scriptDir, '..');
const defaultSourceDir = path.join(packageDir, 'src', 'marketplace', 'catalog-data');
const defaultTargetDir = path.join(packageDir, 'dist', 'marketplace', 'catalog-data');

export async function copyMarketplaceCatalogData({ sourceDir = defaultSourceDir, targetDir = defaultTargetDir } = {}) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  let copiedCount = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    await copyFile(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
    copiedCount += 1;
  }

  return copiedCount;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await copyMarketplaceCatalogData();
}
