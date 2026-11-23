import { deploymentDefaults } from '@cat-cafe/shared';
import type { Metadata, Viewport } from 'next';
import { META_THEME_COLOR } from '@/lib/color-defaults';
import { buildPwaRetirementScript } from '@/lib/pwa-retirement-script';
import { runtimeApiOriginFromPort } from '@/lib/runtime-api-origin';

// The document must carry this process's API port, never a statically baked build port.
export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: META_THEME_COLOR,
};

export const metadata: Metadata = {
  title: deploymentDefaults.brand.name,
  description: deploymentDefaults.brand.tagline,
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/icons/favicon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: deploymentDefaults.brand.name,
  },
};

const browserBuildRevision = process.env.NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION?.trim().toLowerCase();
const embeddedBrowserBuildRevision =
  browserBuildRevision && /^[0-9a-f]{40}$/.test(browserBuildRevision) ? browserBuildRevision : undefined;
const pwaEnabled = process.env.NEXT_PUBLIC_CAT_CAFE_PWA_ENABLED === '1';
const pwaRetirementScript = buildPwaRetirementScript({ enabled: pwaEnabled });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      data-cat-cafe-build-revision={embeddedBrowserBuildRevision}
      data-cat-cafe-pwa-retirement={pwaEnabled ? 'enabled' : 'disabled'}
      data-pwa-cleanup-state={pwaEnabled ? 'enabled' : 'pending'}
      data-cat-cafe-api-origin={runtimeApiOriginFromPort(process.env.API_SERVER_PORT)}
    >
      <body>
        {pwaRetirementScript ? (
          <script
            id="cat-cafe-pwa-retirement"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: generated from a static allowlist/build flag and must stay inline because an old worker can serve every external chunk.
            dangerouslySetInnerHTML={{ __html: pwaRetirementScript }}
          />
        ) : null}
        {children}
      </body>
    </html>
  );
}
