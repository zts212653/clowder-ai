import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeTextAsset } from './vendor-asset-publication.mjs';

// Cascade order is shared by publication and the document head.
export const appGlobalCssFiles = JSON.parse(readFileSync(new URL('./app-global-styles.json', import.meta.url), 'utf8'));

function stylesheet(contents, url) {
  const fingerprint = createHash('sha256').update(contents).digest('hex').slice(0, 16);
  return { contents, url, versionedUrl: url.replace(/\.css$/, `.${fingerprint}.css`) };
}

function appStylesheets(webRoot) {
  return appGlobalCssFiles.map((file) => {
    const raw = readFileSync(resolve(webRoot, 'src/app', file), 'utf8');
    const contents =
      file === 'shell-v2.css'
        ? raw.replace(
            '@import "@cat-cafe/ui/styles.css";',
            readFileSync(resolve(webRoot, '../ui/src/styles.css'), 'utf8'),
          )
        : raw;
    return stylesheet(contents, `/vendor/app/${file}`);
  });
}

function writeManifest(webRoot, urls) {
  writeTextAsset(resolve(webRoot, 'src/generated/vendor-stylesheets.json'), `${JSON.stringify(urls, null, 2)}\n`);
  return urls;
}

/** Rebase source CSS fingerprints after export transforms, without installing packages. */
export function refreshAppStylesheetManifest(webRoot) {
  return writeManifest(
    webRoot,
    appStylesheets(webRoot).map((item) => item.versionedUrl),
  );
}

/** Publish immutable bytes before exposing the URLs to Next's document renderer. */
export function syncStylesheets(webRoot) {
  const sources = appStylesheets(webRoot);
  const urls = sources.map(({ contents, url, versionedUrl }) => {
    writeTextAsset(resolve(webRoot, `public${versionedUrl}`), contents);
    // Existing consumers retain their aliases. New documents only consume the
    // immutable URLs; earlier versions stay available to already-open pages.
    writeTextAsset(resolve(webRoot, `public${url}`), contents);
    return versionedUrl;
  });
  return writeManifest(webRoot, urls);
}
