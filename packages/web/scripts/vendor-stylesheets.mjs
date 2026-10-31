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
  const manifest = JSON.parse(readFileSync(resolve(webRoot, 'src/generated/vendor-stylesheets.json'), 'utf8'));
  const external = manifest.filter((url) => !url.startsWith('/vendor/app/'));
  if (external.length !== 1 || !/^\/vendor\/xterm\/xterm\.[a-f0-9]{16}\.css$/.test(external[0])) {
    throw new Error('Expected the existing dependency stylesheet fingerprint');
  }
  return writeManifest(webRoot, [...appStylesheets(webRoot).map((item) => item.versionedUrl), ...external]);
}

/** Publish immutable bytes before exposing the URLs to Next's document renderer. */
export function syncStylesheets(webRoot, xtermCssPath) {
  const sources = [
    ...appStylesheets(webRoot),
    stylesheet(readFileSync(xtermCssPath, 'utf8'), '/vendor/xterm/xterm.css'),
  ];
  const urls = sources.map(({ contents, url, versionedUrl }) => {
    writeTextAsset(resolve(webRoot, `public${versionedUrl}`), contents);
    // Existing consumers retain their aliases. New documents only consume the
    // immutable URLs; earlier versions stay available to already-open pages.
    writeTextAsset(resolve(webRoot, `public${url}`), contents);
    return versionedUrl;
  });
  return writeManifest(webRoot, urls);
}
