/**
 * F314-1: the rail's co-creator avatar promises "onError falls back to initial".
 * Renders the real WorldRail (neighbouring rail entries stubbed) and breaks the image.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const coCreator = vi.hoisted(() => ({
  value: { name: 'riley', avatar: 'https://example.invalid/me.png' as string | undefined },
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useApprovalHub', () => ({ useApprovalHubSync: () => undefined }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => coCreator.value }));
vi.mock('@/hooks/usePinnedSections', () => ({ usePinnedSections: () => ({ pinned: [] }) }));
vi.mock('@/components/collective/use-collective-world-directory-recovery', () => ({
  useCollectiveWorldDirectoryRecovery: () => undefined,
}));
vi.mock('@/components/concierge/ConciergeRailToggle', () => ({ useConciergeRailToggle: () => ({ visible: false }) }));
vi.mock('@/components/ActivityBar', () => ({ ClapperboardIcon: () => null }));
vi.mock('@/components/settings/settings-ia', () => ({ resolvePin: () => null }));
vi.mock('@/components/shell/CollectiveWorldRailEntries', () => ({ CollectiveWorldRailEntries: () => null }));
vi.mock('@/components/shell/MailboxButton', () => ({ MailboxButton: () => null }));
vi.mock('@/components/shell/ShellIcons', () => ({ CatBallImage: () => null }));
vi.mock('@/components/shell/use-open-destination', () => ({ useOpenDestination: () => ({ openPin: vi.fn() }) }));
vi.mock('@/components/shell/use-presentation-rail', () => ({ usePresentationRail: () => ({ visible: false }) }));
vi.mock('@/components/shell/useSettingsSourceReturn', () => ({ useSettingsReadingEntry: () => () => undefined }));

import { WorldRail } from '@/components/shell/WorldRail';

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  coCreator.value = { name: 'riley', avatar: 'https://example.invalid/me.png' };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function avatarButton(): HTMLElement {
  const button = container.querySelector<HTMLElement>('[data-testid="settings-button"]');
  if (!button) throw new Error('Missing settings button');
  return button;
}

/** What a person sees in the avatar slot: a visible image, else the text shown. */
function visibleAvatar(): string {
  const img = avatarButton().querySelector('img');
  if (img && img.style.display !== 'none') return `img ${img.getAttribute('src')}`;
  return `text "${avatarButton().textContent?.trim() ?? ''}"`;
}

describe('WorldRail co-creator avatar (F314-1)', () => {
  it('shows the initial when the avatar image cannot load', async () => {
    await act(async () => root.render(<WorldRail />));
    expect(visibleAvatar()).toBe('img https://example.invalid/me.png');

    await act(async () => avatarButton().querySelector('img')?.dispatchEvent(new Event('error')));
    expect(visibleAvatar()).toBe('text "R"');
  });

  it('shows the new avatar after the owner replaces a broken one', async () => {
    await act(async () => root.render(<WorldRail />));
    await act(async () => avatarButton().querySelector('img')?.dispatchEvent(new Event('error')));

    coCreator.value = { name: 'riley', avatar: 'https://example.invalid/me-v2.png' };
    await act(async () => root.render(<WorldRail />));
    expect(visibleAvatar()).toBe('img https://example.invalid/me-v2.png');
  });

  it('shows the initial when no avatar is set', async () => {
    coCreator.value = { name: 'riley', avatar: undefined };
    await act(async () => root.render(<WorldRail />));
    expect(visibleAvatar()).toBe('text "R"');
  });
});
