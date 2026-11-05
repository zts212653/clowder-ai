'use client';

import { useRef, useState } from 'react';
import { ComposerPopover } from '../ComposerPopover';
import { type RailBadge, RailButton } from './RailButton';
import { ShellGlyph } from './ShellIcons';
import { useWorldRailEntries, type WorldRailEntry } from './use-world-rail-entries';

const MAX_DIRECT_WORLDS = 3;

export function CollectiveWorldRailEntries({
  inCollective,
  onOpenWorld,
  onOpenDirectory,
}: {
  readonly inCollective: boolean;
  readonly onOpenWorld: (href: string) => void;
  readonly onOpenDirectory: () => void;
}) {
  const directory = useWorldRailEntries();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowAnchor = useRef<HTMLButtonElement>(null);
  const selectedKey = inCollective
    ? (directory.worlds.find((world) => world.active)?.key ?? explicitWorldKey())
    : undefined;
  const directWorlds = directEntries(directory.worlds, selectedKey);

  return (
    <>
      {directWorlds.map((world) => (
        <WorldButton
          key={world.key}
          world={world}
          selected={world.key === selectedKey}
          onOpen={() => onOpenWorld(world.href)}
        />
      ))}
      {directory.worlds.length > MAX_DIRECT_WORLDS && (
        <>
          <RailButton
            ref={overflowAnchor}
            ariaLabel="查看全部共同体"
            tip="全部共同体"
            selected={overflowOpen}
            ariaExpanded={overflowOpen}
            ariaHasPopup="dialog"
            onClick={() => setOverflowOpen((open) => !open)}
            testId="world-more"
            disableTip={overflowOpen}
          >
            <ShellGlyph name="more" className="h-5 w-5" />
          </RailButton>
          {overflowOpen && (
            <ComposerPopover
              anchor={overflowAnchor}
              label="选择共同体"
              onClose={() => setOverflowOpen(false)}
              preferredWidth={280}
              presentation="anchor"
            >
              <div className="flex flex-col gap-0.5 p-1" data-testid="world-overflow-panel">
                {directory.worlds.map((world) => (
                  <button
                    key={world.key}
                    type="button"
                    aria-label={world.name}
                    aria-current={world.key === selectedKey ? 'page' : undefined}
                    data-testid={`world-overflow-${testKey(world)}`}
                    className="shell-focusable shell-rail-item flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left"
                    onClick={() => {
                      setOverflowOpen(false);
                      onOpenWorld(world.href);
                    }}
                  >
                    <WorldMark name={world.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--shell-ink)]">{world.name}</span>
                      <span className="block truncate text-xs text-[var(--shell-muted)]">{world.statusText}</span>
                    </span>
                  </button>
                ))}
              </div>
            </ComposerPopover>
          )}
        </>
      )}
      <RailButton
        ariaLabel="加入或新建共同体"
        tip="加入或新建共同体"
        tipDetail={directory.statusText}
        badge={directory.worlds.length === 0 ? directoryBadge(directory.status) : null}
        dimmed={directory.status === 'session_required'}
        onClick={onOpenDirectory}
        testId="world-add"
        guideId="nav.collective"
      >
        <ShellGlyph name="plus" className="h-5 w-5" />
      </RailButton>
    </>
  );
}

function WorldButton({
  world,
  selected,
  onOpen,
}: {
  readonly world: WorldRailEntry;
  readonly selected: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <RailButton
      ariaLabel={world.name}
      tip={world.name}
      tipDetail={world.statusText}
      selected={selected}
      ariaCurrent={selected ? 'page' : undefined}
      badge={worldBadge(world.status)}
      dimmed={world.status === 'unavailable'}
      onClick={onOpen}
      testId={`world-${testKey(world)}`}
    >
      <WorldMark name={world.name} />
    </RailButton>
  );
}

function WorldMark({ name }: { readonly name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-6 w-6 items-center justify-center rounded-[7px] border border-[var(--shell-hairline-strong)] bg-[var(--shell-paper)] text-[11px] font-semibold text-[var(--shell-ink)]"
    >
      {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'}
    </span>
  );
}

function directEntries(worlds: readonly WorldRailEntry[], selectedKey?: string): readonly WorldRailEntry[] {
  if (worlds.length <= MAX_DIRECT_WORLDS) return worlds;
  const selected = worlds.find((world) => world.key === selectedKey);
  if (!selected) return worlds.slice(0, MAX_DIRECT_WORLDS);
  if (worlds.slice(0, MAX_DIRECT_WORLDS).includes(selected)) return worlds.slice(0, MAX_DIRECT_WORLDS);
  return [...worlds.slice(0, MAX_DIRECT_WORLDS - 1), selected];
}

function explicitWorldKey(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const params = new URLSearchParams(window.location.search);
  const serviceInstanceId = params.get('serviceInstanceId');
  const collectiveId = params.get('collectiveId');
  return serviceInstanceId && collectiveId ? `${serviceInstanceId}:${collectiveId}` : undefined;
}

function testKey(world: Pick<WorldRailEntry, 'serviceInstanceId' | 'collectiveId'>): string {
  return `${world.serviceInstanceId}-${world.collectiveId}`;
}

function worldBadge(status: WorldRailEntry['status']): RailBadge {
  if (status === 'checking') return 'loading';
  if (status === 'unavailable') return 'alert';
  return null;
}

function directoryBadge(status: ReturnType<typeof useWorldRailEntries>['status']): RailBadge {
  switch (status) {
    case 'checking':
      return 'loading';
    case 'session_required':
    case 'unavailable':
    case 'service_mismatch':
      return 'alert';
    case 'unknown':
    case 'ready':
      return null;
  }
}
