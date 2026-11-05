import fs from 'node:fs';
import path from 'node:path';
import { appGlobalCssFiles } from '../../packages/web/scripts/sync-vendor-assets.mjs';

/** Generated public/vendor and serviceworker files are not in git's source inventory. */
export function stageBuiltWeb(source, destination) {
  for (const file of appGlobalCssFiles) {
    const asset = path.join(source, 'public/vendor/app', file);
    if (!fs.existsSync(asset) || !fs.statSync(asset).size) throw new Error(`Missing built Web CSS asset: ${file}`);
  }
  if (!fs.existsSync(path.join(source, '.next/BUILD_ID'))) throw new Error('Missing Web build identity');
  const copy = (from, to) =>
    fs.cpSync(from, to, {
      recursive: true,
      filter: (entry) => {
        if (path.resolve(entry) === path.resolve(source, '.next/cache/webpack')) return false;
        if (fs.lstatSync(entry).isSymbolicLink()) throw new Error('Linked Web build asset');
        return true;
      },
    });
  copy(path.join(source, 'public'), path.join(destination, 'public'));
  copy(path.join(source, '.next'), path.join(destination, '.next'));
}
