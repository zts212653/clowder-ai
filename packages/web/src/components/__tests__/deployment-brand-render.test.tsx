import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const brand = vi.hoisted(() => ({
  name: 'Synthetic ASCII',
  displayName: 'Synthetic Écran',
  shortName: 'Syn',
  hubName: 'Synthetic Hub',
  tagline: 'Synthetic collaboration space',
}));
vi.mock('@cat-cafe/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cat-cafe/shared')>();
  return { ...actual, deploymentDefaults: { ...actual.deploymentDefaults, brand } };
});
vi.mock('@/components/AppShell', () => ({ AppShell: () => null }));
vi.mock('@/components/BrakeModal', () => ({ BrakeModal: () => null }));
vi.mock('@/components/CatHueInjector', () => ({ CatHueInjector: () => null }));
vi.mock('@/components/CoCreatorHueInjector', () => ({ CoCreatorHueInjector: () => null }));
vi.mock('@/components/GuideOverlay', () => ({ GuideOverlay: () => null }));
vi.mock('@/components/SessionBootstrap', () => ({ SessionBootstrap: () => null }));
vi.mock('@/components/ThemeApplier', () => ({ ThemeApplier: () => null }));
vi.mock('@/components/ThemeProvider', () => ({ ThemeProvider: () => null }));
vi.mock('@/components/ToastContainer', () => ({ ToastContainer: () => null }));
vi.mock('@/components/useConfirm', () => ({ ConfirmProvider: () => null }));
vi.mock('@/components/settings/SettingsShell', () => ({ SettingsShell: () => null }));
vi.mock('@/components/shell/shell-presentation', () => ({ useShellPresentation: () => 'classic' }));
vi.mock('@/components/shell/useSettingsSourceReturn', () => ({ useSettingsReadingEntry: () => ({}) }));
vi.mock('@/components/ThreadIndicator', () => ({ ThreadIndicator: () => null, tailTruncate: (s: string) => s }));
vi.mock('@/components/ThreadCatPill', () => ({ ThreadCatPill: () => null }));
vi.mock('@/components/message-search/MessageSearchButton', () => ({ MessageSearchButton: () => null }));
vi.mock('@/components/ChatInput', () => ({ ChatInput: () => null }));
vi.mock('@/components/MiniThreadSidebar', () => ({ MiniThreadSidebar: () => null }));
vi.mock('@/components/SplitPaneCell', () => ({ SplitPaneCell: () => null, SplitPanePlaceholder: () => null }));
vi.mock('@/hooks/useSendMessage', () => ({ useSendMessage: () => ({}) }));
vi.mock('@/hooks/usePushNotify', () => ({ usePushNotify: () => ({ isSupported: false }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (s: unknown) => unknown) =>
    select({
      threads: [],
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      threadStates: {},
      setSplitPaneTarget: vi.fn(),
      setSplitPaneThreadIds: vi.fn(),
      getThreadState: vi.fn(),
    }),
}));

import { metadata } from '@/app/layout';
import { metadata as settingsMetadata } from '@/app/settings/page';
import { ChatContainerHeader } from '@/components/ChatContainerHeader';
import { PushSettingsPanel } from '@/components/PushSettingsPanel';
import { SplitPaneView } from '@/components/SplitPaneView';

describe('selected deployment brand reaches real Web consumers', () => {
  it('supplies document, install and settings metadata with the ASCII variant', () => {
    expect(metadata.title).toBe(brand.name);
    expect(metadata.description).toBe(brand.tagline);
    expect(metadata.appleWebApp).toMatchObject({ title: brand.name });
    expect(settingsMetadata.title).toBe(`设置 — ${brand.name}`);
  });
  it('renders the display variant in the single-pane header', () => {
    const html = renderToStaticMarkup(
      <ChatContainerHeader
        sidebarOpen={false}
        onToggleSidebar={vi.fn()}
        threadId="fixture"
        viewMode="single"
        onToggleViewMode={vi.fn()}
        statusPanelOpen={false}
        onToggleStatusPanel={vi.fn()}
      />,
    );
    expect(html).toMatch(new RegExp(`<h1[^>]*>${brand.displayName}</h1>`));
  });
  it('renders the ASCII variant in the split-pane header', () => {
    const html = renderToStaticMarkup(<SplitPaneView onSend={vi.fn()} onZoomToThread={vi.fn()} />);
    expect(html).toMatch(new RegExp(`<h1[^>]*>${brand.name}</h1>`));
  });
  it('renders the display variant in unsupported push installation guidance', () => {
    const html = renderToStaticMarkup(<PushSettingsPanel />);
    expect(html).toContain(`iPhone 用户请将 ${brand.displayName} 添加到主屏幕后再开启推送`);
  });
});
