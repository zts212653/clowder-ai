'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { lazy, Suspense, useCallback, useState } from 'react';
import { usePinnedSections } from '@/hooks/usePinnedSections';
import { useCallbackAuthAggregate, useCallbackAuthAvailable } from '@/stores/callbackAuthStore';
import { useChatStore } from '@/stores/chatStore';
import { ConciergeRailToggle } from './concierge/ConciergeRailToggle';
import { HubIcon } from './hub-icons';
import { MemoryIcon } from './icons/MemoryIcon';
import { SETTINGS_SECTIONS } from './settings/settings-nav-config';
import { ThemeMenu } from './ThemeMenu';
import { getThreadIdFromPathname } from './ThreadSidebar/thread-navigation';

const OklchTuner = lazy(() => import('./dev/OklchTuner').then((m) => ({ default: m.OklchTuner })));

const NAV_ITEMS = [
  { id: 'home', path: '/', label: '对话', match: (p: string) => p === '/' || p.startsWith('/thread/') },
  { id: 'memory', path: '/memory', label: '记忆', match: (p: string) => p.startsWith('/memory') },
  { id: 'mission', path: '/mission-hub', label: 'Mission Hub', match: (p: string) => p.startsWith('/mission') },
  { id: 'signals', path: '/signals', label: '信号', match: (p: string) => p.startsWith('/signals') },
] as const;

function ChatIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>对话</title>
      <path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MissionIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>Mission Hub</title>
      <path
        d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M15 3v4a1 1 0 0 0 1 1h4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 13h6" strokeLinecap="round" />
      <path d="M9 17h3" strokeLinecap="round" />
    </svg>
  );
}

function SignalIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>信号</title>
      <path
        d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="4" y1="22" x2="4" y2="15" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>设置</title>
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ICON_MAP: Record<string, ({ className }: { className?: string }) => JSX.Element> = {
  home: ChatIcon,
  signals: SignalIcon,
  memory: MemoryIcon,
  mission: MissionIcon,
  settings: SettingsIcon,
};

interface ActivityBarProps {
  className?: string;
}

function readFromParam(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('from');
}

function getNavigationReferrer(pathname: string): string | null {
  const threadId = getThreadIdFromPathname(pathname);
  return threadId !== 'default' ? threadId : readFromParam();
}

function appendReferrer(path: string, referrer: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}from=${encodeURIComponent(referrer)}`;
}

function resolveNavTarget(path: string, pathname: string): string {
  if (path === '/') {
    const fromParam = readFromParam();
    return fromParam ? `/thread/${encodeURIComponent(fromParam)}` : '/';
  }
  const referrer = getNavigationReferrer(pathname);
  return referrer ? appendReferrer(path, referrer) : path;
}

function PinnedSections({ pinned, onNav }: { pinned: readonly string[]; onNav: (path: string) => void }) {
  const searchParams = useSearchParams();
  const activeSection = searchParams?.get('s') ?? '';
  const isStandalone = searchParams?.get('standalone') === '1';

  const pinnedSections = pinned
    .map((id) => SETTINGS_SECTIONS.find((s) => s.id === id))
    .filter((s): s is (typeof SETTINGS_SECTIONS)[number] => s != null);

  if (pinnedSections.length === 0) return null;

  return (
    <>
      <div className="my-1 h-px w-6 bg-[var(--console-border-soft)] opacity-50" />
      {pinnedSections.map((sec) => {
        const active = isStandalone && activeSection === sec.id;
        return (
          <button
            key={sec.id}
            type="button"
            onClick={() => onNav(`/settings?s=${sec.id}&standalone=1`)}
            className={`flex h-10 w-10 items-center justify-center rounded-lg transition-all ${
              active
                ? 'bg-[var(--console-rail-active)] shadow-[var(--console-rail-shadow)]'
                : 'hover:bg-[var(--console-rail-item)] hover:shadow-[var(--console-rail-shadow)]'
            }`}
            title={sec.label}
            aria-current={active ? 'page' : undefined}
          >
            <HubIcon name={sec.icon} className="h-[18px] w-[18px]" />
          </button>
        );
      })}
    </>
  );
}

const DEGRADED_COLOR = 'var(--semantic-warning)';
const BROKEN_COLOR = 'var(--semantic-critical)';
const BROKEN_THRESHOLD = 6;

function SettingsButton({ pathname, onNav }: { pathname: string; onNav: (path: string) => void }) {
  const searchParams = useSearchParams();
  const isSettingsRoute = pathname.startsWith('/settings');
  const isStandalone = isSettingsRoute && searchParams?.get('standalone') === '1';
  const isSettings = isSettingsRoute && !isStandalone;

  const aggregate = useCallbackAuthAggregate();
  const isAvailable = useCallbackAuthAvailable();
  const unviewed = isAvailable ? aggregate.unviewedFailures24h : 0;
  const showBadge = unviewed > 0;
  const badgeColor = unviewed >= BROKEN_THRESHOLD ? BROKEN_COLOR : DEGRADED_COLOR;
  const badgeText = unviewed > 99 ? '99+' : String(unviewed);

  return (
    <button
      type="button"
      onClick={() => onNav('/settings')}
      className={`relative flex h-10 w-10 items-center justify-center rounded-lg transition-all ${
        isSettings
          ? 'bg-[var(--console-rail-active)] shadow-[var(--console-rail-shadow)]'
          : 'hover:bg-[var(--console-rail-item)] hover:shadow-[var(--console-rail-shadow)]'
      }`}
      title={showBadge ? `设置 · MCP Callback Auth 24h ${unviewed} 次未查看失败` : '设置'}
      aria-current={isSettings ? 'page' : undefined}
      data-guide-id="hub.trigger"
      data-testid="settings-button"
      data-callback-auth-unviewed={showBadge ? String(unviewed) : undefined}
    >
      <SettingsIcon className="h-5 w-5" />
      {showBadge && (
        <span
          data-testid="settings-callback-auth-badge"
          className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-micro font-bold flex items-center justify-center"
          style={{
            backgroundColor: badgeColor,
            color: 'var(--cafe-accent-foreground)',
            maxWidth: '22px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {badgeText}
        </span>
      )}
    </button>
  );
}

function ClapperboardIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>演示浮窗</title>
      <path
        d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m6.2 5.3 3.1 3.9M12.4 3.4l3.1 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** F226: global presentation-surface toggle — visible across all routes so the
 *  float can be collapsed/recalled even from Memory Hub / Settings (spec Phase A). */
function PresentationRailToggle() {
  const surface = useChatStore((s) => s.presentationSurface);
  const minimizeFloat = useChatStore((s) => s.minimizeFloat);
  if (!surface) return null;
  const minimized = surface.minimized;
  return (
    <button
      type="button"
      onClick={() => minimizeFloat(!minimized)}
      className={`flex h-10 w-10 items-center justify-center rounded-lg transition-all ${
        minimized
          ? 'hover:bg-[var(--console-rail-item)] hover:shadow-[var(--console-rail-shadow)]'
          : 'bg-[var(--console-rail-active)] shadow-[var(--console-rail-shadow)]'
      }`}
      title={minimized ? '召回演示浮窗（还原讲稿）' : '收起演示浮窗'}
      data-testid="presentation-rail-toggle"
    >
      <ClapperboardIcon className="h-5 w-5" />
    </button>
  );
}

export function ActivityBar({ className }: ActivityBarProps) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const { pinned } = usePinnedSections();
  const [tunerOpen, setTunerOpen] = useState(false);

  const handleNav = useCallback(
    (path: string) => {
      router.push(resolveNavTarget(path, pathname));
    },
    [pathname, router],
  );

  return (
    <nav
      className={`flex w-[52px] flex-shrink-0 flex-col items-center gap-1.5 py-2.5 px-[6px] bg-[var(--console-rail-bg)] ${className ?? ''}`}
      aria-label="主导航"
    >
      {NAV_ITEMS.map((item) => {
        const Icon = ICON_MAP[item.id];
        const active = item.match(pathname);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => handleNav(item.path)}
            className={`flex h-10 w-10 items-center justify-center rounded-lg transition-all ${
              active
                ? 'bg-[var(--console-rail-active)] shadow-[var(--console-rail-shadow)]'
                : 'hover:bg-[var(--console-rail-item)] hover:shadow-[var(--console-rail-shadow)]'
            }`}
            title={item.label}
            aria-current={active ? 'page' : undefined}
            data-guide-id={`nav.${item.id}`}
          >
            <Icon className="h-5 w-5" />
          </button>
        );
      })}

      <Suspense>
        <PinnedSections pinned={pinned} onNav={handleNav} />
      </Suspense>

      <div className="mt-auto flex flex-col items-center gap-1.5">
        {/* F229: concierge re-entry —唤回入口，muted 时是唯一入口 (INV-3) */}
        <ConciergeRailToggle />
        <PresentationRailToggle />
        <ThemeMenu onEditTheme={() => setTunerOpen(true)} />
        <Suspense
          fallback={
            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-lg transition-all"
              title="设置"
              data-guide-id="hub.trigger"
            >
              <SettingsIcon className="h-5 w-5" />
            </button>
          }
        >
          <SettingsButton pathname={pathname} onNav={handleNav} />
        </Suspense>
      </div>
      {tunerOpen && (
        <Suspense>
          <OklchTuner onClose={() => setTunerOpen(false)} />
        </Suspense>
      )}
    </nav>
  );
}
