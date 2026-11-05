import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appGlobalCssFiles,
  refreshAppStylesheetManifest,
  syncStylesheets,
} from '../../packages/web/scripts/vendor-stylesheets.mjs';

// Run the production generator in a temporary checkout, so checking never repairs
// the tracked source as a side effect. Include xterm once dependencies exist.
export function generatedStylesheetManifest(sourceWeb, xtermCssPath) {
  const root = mkdtempSync(join(tmpdir(), 'vendor-stylesheet-source-check-'));
  const web = join(root, 'web');
  const manifest = join(web, 'src/generated/vendor-stylesheets.json');
  try {
    mkdirSync(join(web, 'src/app'), { recursive: true });
    mkdirSync(join(web, 'src/generated'), { recursive: true });
    mkdirSync(join(root, 'ui/src'), { recursive: true });
    for (const file of appGlobalCssFiles) {
      copyFileSync(join(sourceWeb, 'src/app', file), join(web, 'src/app', file));
    }
    copyFileSync(join(sourceWeb, '../ui/src/styles.css'), join(root, 'ui/src/styles.css'));
    const checkedIn = readFileSync(join(sourceWeb, 'src/generated/vendor-stylesheets.json'), 'utf8');
    writeFileSync(manifest, checkedIn);
    if (xtermCssPath) syncStylesheets(web, xtermCssPath);
    else refreshAppStylesheetManifest(web);
    return { checkedIn, generated: readFileSync(manifest, 'utf8') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
