const withPWA = require('@ducanh2912/next-pwa').default;

const enablePwaInDev = process.env.ENABLE_PWA_IN_DEV === '1';

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
    return `http://localhost:${frontendPort + 1}`;
  }

  const explicit = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, '');
  if (explicit) return explicit;

  return 'http://localhost:3004';
}

const apiBaseUrl = resolveApiBaseUrl();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { proxyTimeout: 120_000 },
  // 允许 Tailscale 网段设备访问 dev server 的 /_next/* 资源
  allowedDevOrigins: ['100.0.0.0/8'],
  async headers() {
    // F156 D-3: Strict CSP baseline.
    // Next.js hydration requires 'unsafe-inline' for scripts — nonce-based CSP
    // needs middleware (future work). Blocking 'unsafe-eval' prevents eval() injection.
    const csp = ["frame-ancestors 'none'", "script-src 'self' 'unsafe-inline'", "object-src 'none'"].join('; ');
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
    config.ignoreWarnings = [{ module: /onnxruntime-web/ }];
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

module.exports = withPWA({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development' && !enablePwaInDev,
  reloadOnOnline: true,
  // Start URL is a static shell; precache it so PWA cold-open does not block on network.
  dynamicStartUrl: false,
  // Keep default page/document runtime caching and only override what we need.
  extendDefaultRuntimeCaching: true,
  workboxOptions: {
    disableDevLogs: true,
    runtimeCaching: [
      {
        // API calls: never cache — always fresh chat data
        urlPattern: /^https?:\/\/.*\/api\//,
        handler: 'NetworkOnly',
      },
      {
        // WebSocket upgrade requests: skip caching
        urlPattern: /^https?:\/\/.*\/socket\.io/,
        handler: 'NetworkOnly',
      },
      {
        // Static assets: cache for performance
        urlPattern: /\.(png|jpg|jpeg|svg|gif|ico|woff2?)$/,
        handler: 'CacheFirst',
        options: {
          cacheName: 'static-assets',
          expiration: { maxEntries: 60, maxAgeSeconds: 30 * 24 * 60 * 60 },
        },
      },
    ],
  },
})(nextConfig);
