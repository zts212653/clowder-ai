const { deploymentDefaults, resolveDirectApiPort } = require('../shared/src/deployment-defaults.ts');
const { default: withPWA, runtimeCaching: defaultRuntimeCaching } = require('@ducanh2912/next-pwa');
const { resolveWebBuildRevision } = require('./scripts/build-revision.cjs');
const currentVendorStylesheets = new Set(require('./src/generated/vendor-stylesheets.json'));

const enablePwaInDev = process.env.ENABLE_PWA_IN_DEV === '1';
const pwaDisabled = process.env.NODE_ENV === 'development' && !enablePwaInDev;
const testDistDir = process.env.CAT_CAFE_WEB_TEST_DIST_DIR;
const testTsconfigPath = process.env.CAT_CAFE_WEB_TEST_TSCONFIG;

if (testDistDir && !/^\.next-test-[A-Za-z0-9_-]+$/.test(testDistDir)) {
  throw new Error('CAT_CAFE_WEB_TEST_DIST_DIR must name an isolated .next-test-* directory');
}
if (testTsconfigPath && !/^tsconfig\.next-test-[A-Za-z0-9_-]+\.json$/.test(testTsconfigPath)) {
  throw new Error('CAT_CAFE_WEB_TEST_TSCONFIG must name an isolated tsconfig.next-test-*.json file');
}
if (Boolean(testDistDir) !== Boolean(testTsconfigPath)) {
  throw new Error('CAT_CAFE_WEB_TEST_DIST_DIR and CAT_CAFE_WEB_TEST_TSCONFIG must be provided together');
}

// Resolved through the shared helper so the revision embedded in the browser
// bundle and the one scripts/write-build-stamp.cjs records on disk can never
// drift apart — F294's guard fails closed on a mismatch just as it does on a
// missing stamp.
const webBuildRevision = resolveWebBuildRevision();
const deploymentRevisionRequired =
  process.env.CAT_CAFE_DEPLOYMENT_REVISION_REQUIRED === '1' || process.env.NODE_ENV === 'production';
function resolveApiBaseUrl() {
  // Prefer explicit local port over NEXT_PUBLIC_API_URL: SSR rewrites should
  // hit localhost directly even when the env URL is a public domain (e.g. a
  // cloud tunnel kept around for webhooks / Host allowlist). Otherwise local
  // /uploads/* and same-origin fetches would round-trip through the tunnel.
  const apiPort = Number(process.env.API_SERVER_PORT);
  if (Number.isInteger(apiPort) && apiPort > 0) {
    return `http://localhost:${apiPort}`;
  }

  const frontendPort = Number(process.env.FRONTEND_PORT);
  if (Number.isInteger(frontendPort) && frontendPort > 0) {
    return `http://localhost:${resolveDirectApiPort(frontendPort, deploymentDefaults)}`;
  }

  const explicit = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '');
  if (explicit) return explicit;

  return deploymentDefaults.apiBaseUrl;
}

const apiBaseUrl = resolveApiBaseUrl();
const allowUnsafeEvalInCsp = process.env.NODE_ENV === 'development';

function buildContentSecurityPolicy() {
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (allowUnsafeEvalInCsp) {
    // Next.js dev React Refresh uses eval internally. Keep this dev-only so
    // production continues to block eval injection.
    scriptSrc.push("'unsafe-eval'");
  }
  return ["frame-ancestors 'none'", `script-src ${scriptSrc.join(' ')}`, "object-src 'none'"].join('; ');
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Desktop serves these assets locally. Compile both client and server with
  // this profile so Next never creates .next/cache/images in the signed app.
  images: { unoptimized: process.env.CAT_CAFE_DESKTOP_WEB_BUILD === '1' },
  transpilePackages: ['@cat-cafe/ui'],
  ...(testDistDir ? { distDir: testDistDir } : {}),
  ...(testTsconfigPath ? { typescript: { tsconfigPath: testTsconfigPath } } : {}),
  experimental: { proxyTimeout: 120_000 },
  env: {
    NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION: webBuildRevision ?? '',
    NEXT_PUBLIC_CAT_CAFE_DEPLOYMENT_REVISION_REQUIRED: deploymentRevisionRequired ? '1' : '0',
    NEXT_PUBLIC_CAT_CAFE_PWA_ENABLED: pwaDisabled ? '0' : '1',
  },
  // 允许 Tailscale 网段设备访问 dev server 的 /_next/* 资源
  allowedDevOrigins: ['100.0.0.0/8'],
  async headers() {
    // F156 D-3: Strict CSP baseline.
    // Next.js hydration requires 'unsafe-inline' for scripts — nonce-based CSP
    // needs middleware (future work). Production keeps blocking 'unsafe-eval'.
    const csp = buildContentSecurityPolicy();
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ];
  },
  webpack: (config) => {
    // Suppress onnxruntime-web "Critical dependency" warnings — dynamic require() in
    // minified bundle is expected and cannot be statically analyzed by webpack.
    // Also suppress @next/swc warnings for cross-platform optional deps (#843).
    config.ignoreWarnings = [{ module: /onnxruntime-web/ }, { message: /managed item.*@next[\\/]swc/i }];
    return config;
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiBaseUrl}/api/:path*`,
      },
      {
        source: '/socket.io/:path*',
        destination: `${apiBaseUrl}/socket.io/:path*`,
      },
      {
        source: '/uploads/:path*',
        destination: `${apiBaseUrl}/uploads/:path*`,
      },
    ];
  },
};

// The service worker owns the offline shell and static assets, never API or Socket.IO traffic.
// A request the worker fetches on the page's behalf ignores the page's abort, still leaves the
// connection queue after the page gave up, and is sent again when the browser stops the worker
// mid-flight (docs/bug-report/hub-backend-connection-toast-recurrence, P6). The library defaults
// are kept except the two routes that exist to serve API responses, and every kept matcher declines
// API traffic first. Workbox writes matchers into sw.js with toString(), so each rebuilt matcher
// carries its own source instead of a closure.
const API_TRAFFIC_PATH = /^\/(?:api|socket\.io)(?:\/|$)/;
const API_RESPONSE_CACHES = new Set(['apis', 'cross-origin']);
function declineApiTraffic(urlPattern) {
  if (urlPattern instanceof RegExp) {
    // Same contract as Workbox's RegExpRoute: a cross-origin URL only matches from index 0.
    return new Function(
      '{ url, sameOrigin }',
      `if (${API_TRAFFIC_PATH}.test(url.pathname)) return false;
      const match = ${urlPattern}.exec(url.href);
      return match !== null && (sameOrigin || match.index === 0);`,
    );
  }
  if (typeof urlPattern === 'function') {
    return new Function(
      'context',
      `if (${API_TRAFFIC_PATH}.test(context.url.pathname)) return false;
      return Boolean((${urlPattern})(context));`,
    );
  }
  throw new TypeError(`runtime caching pattern must be a RegExp or function: ${urlPattern}`);
}
const runtimeCaching = [
  {
    // Static assets: cache for performance
    urlPattern: /\.(png|jpg|jpeg|svg|gif|ico|woff2?)$/,
    handler: 'CacheFirst',
    options: {
      cacheName: 'static-assets',
      expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 },
    },
  },
  ...defaultRuntimeCaching.filter((entry) => !API_RESPONSE_CACHES.has(entry.options?.cacheName)),
].map((entry) => ({ ...entry, urlPattern: declineApiTraffic(entry.urlPattern) }));

module.exports = withPWA({
  dest: 'public',
  disable: pwaDisabled,
  reloadOnOnline: false,
  // The document shell carries build-specific chunk references. Resolve it
  // NetworkFirst so an online navigation cannot be trapped on an older build,
  // while the runtime cache still supplies the last coherent shell offline.
  dynamicStartUrl: true,
  // runtimeCaching below is the complete list; merging the library defaults would bring back
  // the API-serving routes.
  extendDefaultRuntimeCaching: false,
  workboxOptions: {
    disableDevLogs: true,
    // Older documents can still request their immutable files, but installing
    // a new worker should not download every historical CSS version.
    manifestTransforms: [
      async (entries) => ({
        manifest: entries.filter((entry) => {
          const url = `/${entry.url.replace(/^\/+/, '')}`;
          return !/^\/vendor\/(?:app|xterm)\/[^/]+\.[a-f0-9]{16}\.css$/.test(url) || currentVendorStylesheets.has(url);
        }),
        warnings: [],
      }),
    ],
    // Keep the Electron package version in the navigation cache key. Desktop
    // starts at /?__clowder_desktop_version=<version> so an older worker may
    // serve static assets, but can never substitute its precached root shell.
    ignoreURLParametersMatching: [/^utm_/, /^fbclid$/],
    runtimeCaching,
  },
})(nextConfig);
