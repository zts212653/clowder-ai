'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { MemoryBookStarIcon, ShellGlyph, YarnBallIcon } from '@/components/shell/ShellIcons';
import { useShellCopy } from '@/components/shell/shell-copy';
import type { WorkspaceLauncherDestination } from '@/components/workspace/WorkspaceLauncher';
import { type LauncherWorkspaceSearch, WorkspaceLauncherSearch } from '@/components/workspace/WorkspaceLauncherSearch';
import {
  destinationTestId,
  HOME_ROWS,
  HOME_TRANSITIONAL_DESTINATIONS,
  type HomeGroupId,
  type HomeRow,
  rowMatchesQuery,
} from './home-rows';
import { homeCopy } from './workspace-home.shell-copy';

/**
 * The tool list of the new shell's Workspace home (home-northstar §1.8 w1 / §1.12 窄栏 1): a search field, then the
 * rows in three groups — 代码 / 活动 / 其他 — each with an icon, a name, a one-line description and, where one is known,
 * the one number or name that goes with it. The layout (wide: description + number + chevron; narrow: two tools per row,
 * name + number) is the CSS container query in `workspace-home-tools.css`; nothing here measures the window.
 */

const GROUP_ORDER: readonly HomeGroupId[] = ['activity', 'code', 'other'];

function RowIcon({ icon }: { icon: HomeRow['icon'] }) {
  if (icon === 'yarnBall') return <YarnBallIcon className="h-4 w-4" />;
  return icon === 'memory' ? (
    <MemoryBookStarIcon className="h-4 w-4" />
  ) : (
    <ShellGlyph name={icon} className="h-4 w-4" />
  );
}

function ToolRow({
  row,
  meta,
  metaKind,
  onClick,
}: {
  row: HomeRow;
  meta?: string;
  /** `count` for a number with its unit ("12 files"): the narrow layout keeps it whole, under the name, when it does not fit. */
  metaKind?: 'count';
  onClick: () => void;
}) {
  const t = useShellCopy(homeCopy);
  const words = t.rows[row.copyKey];
  const destination = row.destination;
  return (
    <button
      type="button"
      className="home-tool shell-focusable"
      onClick={onClick}
      data-testid={destinationTestId(destination)}
      data-workspace-destination={`${destination.kind}:${destination.id}`}
      data-meta-kind={meta ? metaKind : undefined}
    >
      <span className="home-tool-icon">
        <RowIcon icon={row.icon} />
      </span>
      <span className="home-tool-text">
        <b className="home-tool-name text-compact">{words.label}</b>
        <small className="home-tool-desc text-xs">{words.description}</small>
      </span>
      {meta && <span className="home-tool-meta text-xs">{meta}</span>}
      <ShellGlyph name="chevronRight" className="home-tool-chevron h-3.5 w-3.5" />
    </button>
  );
}

function TransitionalLink({
  copy,
  destination,
  onSelect,
}: {
  copy: { lead: string; link: string; tail: string; openLabel: string };
  destination: WorkspaceLauncherDestination;
  onSelect: (destination: WorkspaceLauncherDestination) => void;
}) {
  return (
    <p>
      {copy.lead}
      <button
        type="button"
        className="home-inline-link shell-focusable"
        onClick={() => onSelect(destination)}
        data-testid={destinationTestId(destination)}
        data-workspace-destination={`${destination.kind}:${destination.id}`}
        aria-label={copy.openLabel}
      >
        {copy.link}
      </button>
      {copy.tail}
    </p>
  );
}

export function HomeTools({
  recent,
  footer,
  repository,
  changedFileCount,
  workspaceSearch,
  initialSearchQuery,
  onSelectDestination,
}: {
  recent?: ReactNode;
  footer?: ReactNode;
  repository?: { name: string; branch: string };
  /** Known count of modified files, or `null` when it is not known (the row then says nothing). */
  changedFileCount: number | null;
  workspaceSearch?: LauncherWorkspaceSearch;
  /** Host-owned transient query used when Home is rebuilt from a typed return origin. */
  initialSearchQuery?: string;
  onSelectDestination: (destination: WorkspaceLauncherDestination) => void;
}) {
  const t = useShellCopy(homeCopy);
  const [query, setQuery] = useState(initialSearchQuery ?? '');
  useEffect(() => setQuery(initialSearchQuery ?? ''), [initialSearchQuery]);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const visibleRows = useMemo(
    () => HOME_ROWS.filter((row) => rowMatchesQuery(row, normalizedQuery)),
    [normalizedQuery],
  );

  const metaFor = (row: HomeRow): string | undefined => {
    const { kind, id } = row.destination;
    if (kind !== 'surface') return undefined;
    if (id === 'files') return repository?.name || undefined;
    if (id === 'git') return repository?.branch || undefined;
    if (id === 'changes') return changedFileCount ? t.tools.changedFiles(changedFileCount) : undefined;
    return undefined;
  };

  const metaKindFor = (row: HomeRow): 'count' | undefined =>
    row.destination.kind === 'surface' && row.destination.id === 'changes' ? 'count' : undefined;

  const groups: Array<{ id: HomeGroupId; rows: HomeRow[] }> = GROUP_ORDER.map((id) => ({
    id,
    rows: visibleRows.filter((row) => row.group === id),
  })).filter((group) => group.rows.length > 0);

  return (
    <div className="home-tools" data-testid="workspace-launcher-home">
      <WorkspaceLauncherSearch
        query={query}
        onQueryChange={setQuery}
        workspaceSearch={workspaceSearch}
        placeholder={t.tools.searchPlaceholder}
        labelClassName="home-search"
        copy={t.tools.search}
      />
      {!normalizedQuery && recent}
      {groups.map((group) => (
        <section key={group.id} className="home-group" aria-label={t.tools.groups[group.id]}>
          <h3 className="home-group-title text-xs">{t.tools.groups[group.id]}</h3>
          <div className="home-tool-grid" data-testid="workspace-launcher-grid">
            {group.rows.map((row) => (
              <ToolRow
                key={row.id}
                row={row}
                meta={metaFor(row)}
                metaKind={metaKindFor(row)}
                onClick={() => onSelectDestination({ ...row.destination, label: t.rows[row.copyKey].label })}
              />
            ))}
          </div>
        </section>
      ))}
      {groups.length === 0 && <div className="home-empty-search text-xs">{t.tools.noMatch}</div>}
      {!normalizedQuery &&
        (footer ?? (
          <div className="home-signpost text-xs">
            <p>{t.tools.signpost}</p>
            <TransitionalLink
              copy={t.tools.transitional.allWork}
              destination={{ ...HOME_TRANSITIONAL_DESTINATIONS.allWork, label: t.tools.transitional.allWork.openLabel }}
              onSelect={onSelectDestination}
            />
          </div>
        ))}
    </div>
  );
}
