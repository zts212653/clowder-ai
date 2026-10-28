/**
 * The shared tool catalogue in Workspace v3's + popover, in its three design groups.
 *
 * Every row that opens something hands the host the SAME `WorkspaceLauncherDestination` object the classic launcher hands to
 * `F307WorkspaceHomePage.selectDestination` (worktree admission, pending destination, surface adapters) — taken from
 * `canonicalLauncherDestination`, not re-typed — so there is one place that decides what a destination becomes, down to the
 * title and context of the surface it opens. A row only chooses its own words, icon, order and group.
 *
 * Preservation matrix — what the classic launcher offered and where it is now in the new shell:
 *   files / changes / git / terminal / browser ........ rows below (代码)
 *   status (状态与会话) / trajectory / theater (回放) .... rows below (活动)
 *   recall (记忆) / voice (语音与会议) / films / team ...... rows below (其他)
 *   tasks ............................................. header 毛线球 and the row below, same mode:tasks
 *   artifacts ......................................... header 作品 (HeaderCounts → setWorkspaceMode)
 *   approval / needs-me ............................... mailbox 待办 rows (打开审批列表 / 打开待处理列表)
 *   schedule / eval / community / capability-evolution . rows below, through their original destinations
 *   product-schedule .................................. To-do and this page's Schedule link
 * Configuration stays in Settings; everyday work pages are discoverable here without prior recent history.
 */
import type { ShellGlyphName } from '@/components/shell/ShellIcons';
import {
  canonicalLauncherDestination,
  type WorkspaceLauncherDestination,
} from '@/components/workspace/WorkspaceLauncher';
import { type HomeCopy, homeCopy } from './workspace-home.shell-copy';

export type HomeGroupId = 'code' | 'activity' | 'other';

export type HomeRowIcon = ShellGlyphName | 'memory' | 'yarnBall';

/** A row's words live in the dictionary (`rows.<copyKey>`), in both languages; the row itself only says which. */
export type HomeRowCopyKey = keyof HomeCopy['rows'];

interface HomeRowBase {
  readonly id: string;
  readonly group: HomeGroupId;
  readonly icon: HomeRowIcon;
  readonly copyKey: HomeRowCopyKey;
  /** Words that find the row but are not shown, in either language. */
  readonly searchTerms: string;
}

export interface HomeDestinationRow extends HomeRowBase {
  readonly kind: 'destination';
  readonly destination: WorkspaceLauncherDestination;
}

export type HomeRow = HomeDestinationRow;

function destinationRow(
  group: HomeGroupId,
  icon: HomeRowIcon,
  kind: WorkspaceLauncherDestination['kind'],
  id: HomeRowCopyKey,
  extraSearchTerms = '',
): HomeDestinationRow {
  const destination = canonicalLauncherDestination(kind, id);
  return {
    kind: 'destination',
    id: `${kind}:${id}`,
    group,
    icon,
    copyKey: id,
    searchTerms: `${destination.searchTerms} ${extraSearchTerms}`.trim(),
    destination,
  };
}

export const HOME_ROWS: readonly HomeRow[] = [
  destinationRow('activity', 'activity', 'host', 'status', '成员'),
  destinationRow('activity', 'history', 'mode', 'trajectory'),
  destinationRow('activity', 'play', 'action', 'theater'),
  destinationRow('activity', 'grid', 'mode', 'schedule', '定时任务 cron scheduling'),
  destinationRow('activity', 'checkSquare', 'mode', 'eval', '周期评估 periodic evaluations ledger 台账'),
  destinationRow('activity', 'yarnBall', 'mode', 'tasks'),
  destinationRow('code', 'folder', 'surface', 'files'),
  // The page lists the worktree's modified files (git status), not a per-conversation set: say what it shows.
  destinationRow('code', 'filePen', 'surface', 'changes', '修改'),
  destinationRow('code', 'gitPr', 'surface', 'git'),
  destinationRow('code', 'hash', 'surface', 'terminal'),
  destinationRow('code', 'globe', 'surface', 'browser'),
  destinationRow('other', 'memory', 'mode', 'recall'),
  destinationRow('other', 'headphones', 'host', 'voice'),
  destinationRow('other', 'film', 'host', 'films'),
  destinationRow('other', 'cat', 'mode', 'team'),
  destinationRow('other', 'users', 'mode', 'community'),
  destinationRow('other', 'sparkles', 'workspace', 'capability-evolution', 'evolution 进化'),
];

/** Schedule is also available from To-do; keep the original destination available in the tools signpost. */
export const HOME_TRANSITIONAL_DESTINATIONS = {
  allWork: canonicalLauncherDestination('mode', 'product-schedule'),
} as const;

/**
 * A query finds a row by either language's name or description, whichever language the page is showing: someone who types
 * 终端 on an English page, or "terminal" on a Chinese one, still lands on the row.
 */
export function rowMatchesQuery(row: HomeRow, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const zh = homeCopy.zh.rows[row.copyKey];
  const en = homeCopy.en.rows[row.copyKey];
  return `${zh.label} ${zh.description} ${en.label} ${en.description} ${row.searchTerms}`
    .toLocaleLowerCase()
    .includes(normalizedQuery);
}

export function destinationTestId(destination: WorkspaceLauncherDestination): string {
  return destination.kind === 'surface'
    ? `workspace-launcher-dev-${destination.id}`
    : `workspace-launcher-${destination.id}`;
}
