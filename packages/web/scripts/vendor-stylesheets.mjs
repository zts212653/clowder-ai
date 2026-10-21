import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeTextAsset } from './vendor-asset-publication.mjs';

// Cascade order is shared by publication and the document head.
export const appGlobalCssFiles = [
  'theme-tokens.css',
  'cat-persona-tokens.css',
  'cat-persona-derived.css',
  'connector-tokens.css',
  'theme-extras.css',
  'console-tokens.css',
  'console-shell.css',
  'console-controls.css',
  'shell-v2.css',
];

/** Publish immutable bytes before exposing the URLs to Next's document renderer. */
export function syncStylesheets(webRoot, xtermCssPath) {
  const sources = [
    ...appGlobalCssFiles.map((file) => ({
      source: resolve(webRoot, 'src/app', file),
      url: `/vendor/app/${file}`,
      sharedUi: file === 'shell-v2.css',
    })),
    { source: xtermCssPath, url: '/vendor/xterm/xterm.css', sharedUi: false },
  ];
  const urls = sources.map(({ source, url, sharedUi }) => {
    const raw = readFileSync(source, 'utf8');
    const contents = sharedUi
      ? raw.replace(
          '@import "@cat-cafe/ui/styles.css";',
          readFileSync(resolve(webRoot, '../ui/src/styles.css'), 'utf8'),
        )
      : raw;
    const fingerprint = createHash('sha256').update(contents).digest('hex').slice(0, 16);
    const versionedUrl = url.replace(/\.css$/, `.${fingerprint}.css`);
    writeTextAsset(resolve(webRoot, `public${versionedUrl}`), contents);
    // Existing consumers retain their aliases. New documents only consume the
    // immutable URLs; earlier versions stay available to already-open pages.
    writeTextAsset(resolve(webRoot, `public${url}`), contents);
    return versionedUrl;
  });
  writeTextAsset(resolve(webRoot, 'src/generated/vendor-stylesheets.json'), `${JSON.stringify(urls, null, 2)}\n`);
  return urls;
}
