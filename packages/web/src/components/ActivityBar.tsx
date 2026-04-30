'use client';

import { usePathname } from 'next/navigation';
import { MemoryIcon } from './icons/MemoryIcon';
import { assignDocumentRoute, CLASSIC_WORLD_PREFIX, getThreadIdFromPathname } from './ThreadSidebar/thread-navigation';

const NAV_ITEMS = [
  { id: 'home', path: '/', label: '对话', match: (p: string) => p === '/' || p.startsWith('/thread/') },
  { id: 'memory', path: '/memory', label: '记忆', match: (p: string) => p.startsWith('/memory') },
  { id: 'mission', path: '/mission', label: 'Mission Hub', match: (p: string) => p.startsWith('/mission') },
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

function ThemeIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>主题</title>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" strokeLinecap="round" strokeLinejoin="round" />
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

export function ActivityBar({ className }: ActivityBarProps) {
  const pathname = usePathname() ?? '/';

  const handleNav = (path: string) => {
    const prefix = pathname.startsWith(CLASSIC_WORLD_PREFIX) ? CLASSIC_WORLD_PREFIX : '';
    const threadId = getThreadIdFromPathname(pathname, prefix);
    let referrer = threadId !== 'default' ? threadId : null;
    if (!referrer && typeof window !== 'undefined') {
      referrer = new URLSearchParams(window.location.search).get('from');
    }
    const from = referrer && path !== '/' ? `?from=${encodeURIComponent(referrer)}` : '';
    assignDocumentRoute(`${path}${from}`, typeof window !== 'undefined' ? window : undefined);
  };

  const isSettings = pathname.startsWith('/settings');

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
            className={`flex h-10 w-10 items-center justify-center rounded-[9px] transition-all ${
              active
                ? 'bg-[var(--console-rail-active)] shadow-[0_5px_14px_rgba(43,37,32,0.07)]'
                : 'bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)]'
            }`}
            title={item.label}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className="h-5 w-5" />
          </button>
        );
      })}
      <div className="mt-auto flex flex-col items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            const html = document.documentElement;
            html.setAttribute('data-theme', html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
          }}
          className="flex h-10 w-10 items-center justify-center rounded-[9px] bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)] transition-all"
          title="切换主题"
        >
          <ThemeIcon className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => handleNav('/settings')}
          className={`flex h-10 w-10 items-center justify-center rounded-[9px] transition-all ${
            isSettings
              ? 'bg-[var(--console-rail-active)] shadow-[0_5px_14px_rgba(43,37,32,0.07)]'
              : 'bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)]'
          }`}
          title="设置"
          aria-current={isSettings ? 'page' : undefined}
        >
          <SettingsIcon className="h-5 w-5" />
        </button>
      </div>
    </nav>
  );
}
