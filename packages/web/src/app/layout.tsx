/* eslint-disable @next/next/no-css-tags -- Global CSS that does not need Next processing
 * (xterm vendor + app-level token/control styles) is served as static stylesheets to
 * bypass Next dev's flight CSS loader which chokes on class selectors and non-root CSS. */
import { deploymentDefaults } from '@cat-cafe/shared';
import type { Metadata, Viewport } from 'next';
import { AppShell } from '@/components/AppShell';
import { BrakeModal } from '@/components/BrakeModal';
import { CatHueInjector } from '@/components/CatHueInjector';
import { CoCreatorHueInjector } from '@/components/CoCreatorHueInjector';
import { GuideOverlay } from '@/components/GuideOverlay';
import { SessionBootstrap } from '@/components/SessionBootstrap';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastContainer } from '@/components/ToastContainer';
import { ConfirmProvider } from '@/components/useConfirm';
import vendorStylesheets from '@/generated/vendor-stylesheets.json';
import { META_THEME_COLOR } from '@/lib/color-defaults';
import { buildPwaRetirementScript } from '@/lib/pwa-retirement-script';
import { runtimeApiOriginFromPort } from '@/lib/runtime-api-origin';
import './globals.css';

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
      <head>
        {vendorStylesheets.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
      </head>
      <body className="min-h-screen">
        {pwaRetirementScript ? (
          <script
            id="cat-cafe-pwa-retirement"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: generated from a static allowlist/build flag and must stay inline because an old worker can serve every external chunk.
            dangerouslySetInnerHTML={{ __html: pwaRetirementScript }}
          />
        ) : null}
        <SessionBootstrap />
        <CatHueInjector />
        <CoCreatorHueInjector />
        <ThemeProvider>
          <ThemeApplier />
          <ConfirmProvider>
            <AppShell>{children}</AppShell>
          </ConfirmProvider>
          <BrakeModal />
          <GuideOverlay />
          <ToastContainer />
        </ThemeProvider>
      </body>
    </html>
  );
}
