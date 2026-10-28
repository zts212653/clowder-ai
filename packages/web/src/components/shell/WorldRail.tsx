'use client';

import { WorldRailFrame } from '@cat-cafe/ui';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useCallback, useEffect } from 'react';
import { useApprovalHubSync } from '@/hooks/useApprovalHub';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { usePinnedSections } from '@/hooks/usePinnedSections';
import { ClapperboardIcon } from '../ActivityBar';
import { useCollectiveWorldDirectoryRecovery } from '../collective/use-collective-world-directory-recovery';
import { useConciergeRailToggle } from '../concierge/ConciergeRailToggle';
import { HubIcon } from '../hub-icons';
import { MeowClubMark } from '../icons/MeowClubMark';
import { type ResolvedPin, resolvePin } from '../settings/settings-ia';
import { CollectiveWorldRailEntries } from './CollectiveWorldRailEntries';
import { MailboxButton } from './MailboxButton';
import { RailButton } from './RailButton';
import { CatBallImage } from './ShellIcons';
import { isSettingsRoute } from './settings-reading-bridge';
import { rememberCafeReturnTarget, resolveShellNavTarget } from './shell-navigation';
import { useOpenDestination } from './use-open-destination';
import { usePresentationRail } from './use-presentation-rail';
import { useSettingsReadingEntry } from './useSettingsSourceReturn';

const CAFE_NAME = '我的 Café';

function RailSeparator() {
  return <div aria-hidden="true" className="my-0.5 h-px w-5" style={{ background: 'var(--shell-hairline-strong)' }} />;
}

/**
 * The Café 1.6 global rail (52px): worlds on top; pins, 小信箱, 前台猫 and 头像 at the bottom.
 * Everything here is global and about "me" — the content of a world lives in that world's sidebar.
 */
export function WorldRail() {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  // The one mount of the F246 approval sync for the shell (classic ActivityBar is not rendered alongside).
  useApprovalHubSync();
  useCollectiveWorldDirectoryRecovery();

  const captureSettingsOrigin = useSettingsReadingEntry();
  useEffect(() => rememberCafeReturnTarget(pathname), [pathname]);
  const go = useCallback(
    (path: string) => {
      if (isSettingsRoute(path)) captureSettingsOrigin();
      router.push(resolveShellNavTarget(path, pathname));
    },
    [router, pathname, captureSettingsOrigin],
  );
  const openWorld = useCallback(
    (href: string) => {
      rememberCafeReturnTarget(pathname);
      router.push(href);
    },
    [pathname, router],
  );

  const inCafe = pathname === '/' || pathname.startsWith('/thread/');
  const inCollective = pathname.startsWith('/collective');
  const inSettings = pathname.startsWith('/settings');

  return (
    <WorldRailFrame aria-label="主导航" data-testid="world-rail">
      <CafeWorld selected={inCafe} onOpen={() => go('/')} />
      <RailSeparator />
      <CollectiveWorldRailEntries
        inCollective={inCollective}
        onOpenWorld={openWorld}
        onOpenDirectory={() => go('/collective')}
      />

      <div className="mt-auto flex flex-col items-center gap-1.5">
        <Suspense fallback={null}>
          <PinnedRailItems />
        </Suspense>
        <PresentationToggle />
        <MailboxButton />
        <ConciergeButton />
        <div className="h-1" aria-hidden="true" />
        <AvatarButton selected={inSettings} onOpen={() => go('/settings?s=you')} />
      </div>
    </WorldRailFrame>
  );
}

function CafeWorld({ selected, onOpen }: { selected: boolean; onOpen: () => void }) {
  return (
    <RailButton
      ariaLabel={CAFE_NAME}
      tip={CAFE_NAME}
      selected={selected}
      ariaCurrent={selected ? 'page' : undefined}
      onClick={onOpen}
      testId="world-cafe"
      guideId="nav.home"
    >
      <span className="flex h-6 w-6 items-center justify-center" style={{ color: 'var(--shell-primary)' }}>
        <MeowClubMark className="h-6 w-6" />
      </span>
    </RailButton>
  );
}

function PinnedRailItems() {
  const { pinned } = usePinnedSections();
  const { openPin } = useOpenDestination();
  const pathname = usePathname() ?? '/';
  // Old pins are bare settings-section ids and keep working; new ones are `dest:<entry>`. Unknown ids stay hidden.
  const pins = pinned.map(resolvePin).filter((pin): pin is ResolvedPin => pin != null);
  if (pins.length === 0) return null;
  const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
  return (
    <>
      {pins.map((pin) => {
        const active =
          pin.kind === 'section' &&
          pathname.startsWith('/settings') &&
          params?.get('standalone') === '1' &&
          params.get('s') === pin.id;
        return (
          <RailButton
            key={pin.id}
            ariaLabel={pin.label}
            tip={pin.label}
            selected={active}
            ariaCurrent={active ? 'page' : undefined}
            onClick={() => openPin(pin)}
            testId={`rail-pin-${pin.id.replace(':', '-')}`}
          >
            <HubIcon name={pin.icon} className="h-5 w-5" />
          </RailButton>
        );
      })}
      <RailSeparator />
    </>
  );
}

function PresentationToggle() {
  const { visible, minimized, label, onClick } = usePresentationRail();
  if (!visible) return null;
  return (
    <RailButton ariaLabel={label} tip={label} selected={!minimized} onClick={onClick} testId="presentation-rail-toggle">
      <ClapperboardIcon className="h-5 w-5" />
    </RailButton>
  );
}

function ConciergeButton() {
  const { visible, isOpen, label, onClick } = useConciergeRailToggle();
  if (!visible) return null;
  return (
    <RailButton
      ariaLabel={label}
      tip={label}
      selected={isOpen}
      onClick={() => void onClick()}
      testId="concierge-rail-toggle"
      guideId="rail.concierge"
    >
      <CatBallImage size={28} />
    </RailButton>
  );
}

function AvatarButton({ selected, onOpen }: { selected: boolean; onOpen: () => void }) {
  const coCreator = useCoCreatorConfig();
  return (
    <RailButton
      ariaLabel="设置与管理"
      tip="设置与管理"
      selected={selected}
      ariaCurrent={selected ? 'page' : undefined}
      onClick={onOpen}
      testId="settings-button"
      guideId="hub.trigger"
    >
      <span
        className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full text-xs font-semibold"
        style={{ background: 'var(--color-cocreator-primary)', color: 'var(--cafe-surface)' }}
        aria-hidden="true"
      >
        {coCreator.avatar ? (
          // eslint-disable-next-line @next/next/no-img-element
          // biome-ignore lint/performance/noImgElement: tiny runtime-configured avatar URL, onError falls back to initial
          <img
            src={coCreator.avatar}
            alt=""
            width={28}
            height={28}
            className="h-full w-full object-cover"
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          coCreator.name.slice(0, 1).toUpperCase()
        )}
      </span>
    </RailButton>
  );
}
