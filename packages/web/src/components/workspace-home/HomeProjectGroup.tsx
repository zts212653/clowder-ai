'use client';

import { type ReactNode, useId } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import { useShellCopy } from '@/components/shell/shell-copy';
import { homeCopy } from './workspace-home.shell-copy';

/** Shared project heading for running work and waiting work; only presentation folds. */
export function HomeProjectGroup({
  path,
  label,
  current,
  collapsed,
  busy,
  status,
  ariaLabel,
  cats = [],
  tone = 'live',
  toggle,
  notice,
  children,
}: {
  path: string;
  label: string;
  current: boolean;
  collapsed: boolean;
  busy: boolean;
  status: string;
  ariaLabel: string;
  cats?: string[];
  tone?: 'live' | 'wait';
  toggle(): void;
  notice?: ReactNode;
  children: ReactNode;
}) {
  const t = useShellCopy(homeCopy).live;
  const id = useId();
  return (
    <div className="home-live-project" data-testid="home-live-project" data-project-path={path}>
      <button
        type="button"
        className="home-project-head shell-focusable text-xs"
        aria-expanded={!collapsed}
        aria-controls={id}
        aria-label={current ? `${ariaLabel}, ${t.currentProject}` : ariaLabel}
        title={path}
        disabled={busy}
        onClick={toggle}
      >
        <HomeGroupChevron collapsed={collapsed} />
        <ShellGlyph name="folder" className="home-project-folder" />
        <span className="home-project-name">{label}</span>
        {current && <span className="home-project-current">· {t.currentProject}</span>}
        {collapsed && cats.length > 0 && (
          <>
            <HomeGroupAvatars cats={cats} />
            <span className="home-project-live-dot" data-tone={tone} aria-hidden="true" />
          </>
        )}
        <span className="home-project-count">{status}</span>
      </button>
      {notice}
      <div id={id} hidden={collapsed}>
        {children}
      </div>
    </div>
  );
}

/** Same outlined 16-unit chevron as the sidebar project groups. */
export function HomeGroupChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className="home-project-chevron"
      data-expanded={!collapsed}
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="m6 3 5 5-5 5" />
    </svg>
  );
}

export function HomeGroupAvatars({ cats }: { cats: string[] }) {
  const unique = [...new Set(cats)];
  return (
    <span className="home-project-avatars" aria-hidden="true">
      {unique.slice(0, 4).map((catId) => (
        <CatAvatar key={catId} catId={catId} size={16} ring="none" />
      ))}
      {unique.length > 4 && <span>+{unique.length - 4}</span>}
    </span>
  );
}
