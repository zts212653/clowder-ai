/* eslint-disable @next/next/no-css-tags -- Global CSS that does not need Next processing
 * (xterm vendor + app-level token/control styles) is served as static stylesheets to
 * bypass Next dev's flight CSS loader which chokes on class selectors and non-root CSS. */
import type { Metadata, Viewport } from 'next';
import { AppShell } from '@/components/AppShell';
import { BrakeModal } from '@/components/BrakeModal';
import { CatHueInjector } from '@/components/CatHueInjector';
import { GuideOverlay } from '@/components/GuideOverlay';
import { SessionBootstrap } from '@/components/SessionBootstrap';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastContainer } from '@/components/ToastContainer';
import { ConfirmProvider } from '@/components/useConfirm';
import { META_THEME_COLOR } from '@/lib/color-defaults';
import { buildPwaRetirementScript } from '@/lib/pwa-retirement-script';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: META_THEME_COLOR,
};

export const metadata: Metadata = {
  title: 'Clowder AI',
  description: 'Your AI team collaboration space',
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
    title: 'Clowder AI',
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
    >
      <head>
        <link rel="stylesheet" href="/vendor/app/theme-tokens.css" />
        <link rel="stylesheet" href="/vendor/app/cat-persona-tokens.css" />
        <link rel="stylesheet" href="/vendor/app/cat-persona-derived.css" />
        <link rel="stylesheet" href="/vendor/app/connector-tokens.css" />
        <link rel="stylesheet" href="/vendor/app/theme-extras.css" />
        <link rel="stylesheet" href="/vendor/app/console-tokens.css" />
        <link rel="stylesheet" href="/vendor/app/console-shell.css" />
        <link rel="stylesheet" href="/vendor/app/console-controls.css" />
        <link rel="stylesheet" href="/vendor/app/werewolf-theme.css" />
        <link rel="stylesheet" href="/vendor/xterm/xterm.css" />
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
