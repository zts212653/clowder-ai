import { fileURLToPath } from 'node:url';

export const COLLECTIVE_CLIENT_BUILD_ID = 'collective-client-v2';

const assets = {
  '/collective-client/app.js': {
    contentType: 'text/javascript; charset=utf-8',
    path: fileURLToPath(new URL('./assets/app.js', import.meta.url)),
  },
  '/collective-client/app.css': {
    contentType: 'text/css; charset=utf-8',
    path: fileURLToPath(new URL('./assets/app.css', import.meta.url)),
  },
} as const;

export type CollectiveClientAssetPath = keyof typeof assets;

export function resolveCollectiveClientAsset(pathname: string) {
  return assets[pathname as CollectiveClientAssetPath];
}

export function collectiveClientHtml(): string {
  return `<!doctype html>
<html lang="zh-CN" data-collective-client-build="${COLLECTIVE_CLIENT_BUILD_ID}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#f6f1e9" />
    <title>Collective</title>
    <link rel="stylesheet" href="/collective-client/app.css" />
  </head>
  <body>
    <div id="collective-root" data-client-root="collective"></div>
    <noscript>需要启用 JavaScript 才能进入 Collective。</noscript>
    <script type="module" src="/collective-client/app.js"></script>
  </body>
</html>`;
}
