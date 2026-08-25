import { create } from 'zustand';
import { saveSidebarSnapshot } from '@/utils/offline-store';

export type SidebarPresenceStatus = 'idle' | 'working' | 'done' | 'error';
export type SidebarSystemKind = 'connector_hub' | 'eval_domain' | 'cat_bedroom';

export interface SidebarPresence {
  readonly status: SidebarPresenceStatus;
  readonly cats?: readonly string[];
  readonly activeSince?: number;
}

/** F297 C0-C10: the complete and deliberately narrow Sidebar read model. */
export interface SidebarSnapshotRow {
  readonly id: string;
  readonly title: string | null;
  readonly participants: readonly string[];
  readonly pinned: boolean;
  readonly favorited: boolean;
  readonly labels: readonly string[];
  readonly preferredCats: readonly string[];
  readonly projectPath: string;
  readonly lastActiveAt: number;
  readonly systemKind: SidebarSystemKind | null;
  readonly isHubThread: boolean;
  readonly unreadCount: number;
  readonly hasUserMention: boolean;
  readonly presence: SidebarPresence;
}

export type SidebarCommandField = 'title' | 'pinned' | 'favorited' | 'labels' | 'preferredCats' | 'attention';

export interface SidebarCommandValueMap {
  title: string;
  pinned: boolean;
  favorited: boolean;
  labels: readonly string[];
  preferredCats: readonly string[];
  attention: { readonly unreadCount: number; readonly hasUserMention: boolean };
}

export interface PendingSidebarCommand<F extends SidebarCommandField = SidebarCommandField> {
  readonly id: string;
  readonly threadId: string;
  readonly field: F;
  readonly value: SidebarCommandValueMap[F];
}

export interface SidebarProjectionState {
  rows: readonly SidebarSnapshotRow[];
  appliedGeneration: number;
  hasCanonicalSnapshot: boolean;
  pendingThreadCommands: Readonly<Record<string, PendingSidebarCommand>>;
  refreshing: boolean;
  applySidebarSnapshot: (
    snapshot: readonly SidebarSnapshotRow[],
    requestGeneration: number,
    options?: { source?: 'server' | 'cache' },
  ) => boolean;
  beginSidebarCommand: <F extends SidebarCommandField>(
    threadId: string,
    field: F,
    value: SidebarCommandValueMap[F],
  ) => string;
  failSidebarCommand: (commandId: string) => void;
  clearSidebarCommand: (threadId: string, field: SidebarCommandField) => void;
  setRefreshing: (refreshing: boolean) => void;
}

let commandSequence = 0;

function commandKey(threadId: string, field: SidebarCommandField): string {
  return `${threadId}\u0000${field}`;
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function copySnapshotRow(row: SidebarSnapshotRow): SidebarSnapshotRow {
  return {
    ...row,
    participants: [...row.participants],
    labels: [...row.labels],
    preferredCats: [...row.preferredCats],
    presence: { ...row.presence, ...(row.presence.cats ? { cats: [...row.presence.cats] } : {}) },
  };
}

function rowObservesCommand(row: SidebarSnapshotRow, command: PendingSidebarCommand): boolean {
  switch (command.field) {
    case 'title':
      return row.title === command.value;
    case 'pinned':
      return row.pinned === command.value;
    case 'favorited':
      return row.favorited === command.value;
    case 'labels':
      return equalStringArrays(row.labels, command.value as readonly string[]);
    case 'preferredCats':
      return equalStringArrays(row.preferredCats, command.value as readonly string[]);
    case 'attention': {
      const value = command.value as SidebarCommandValueMap['attention'];
      return row.unreadCount === value.unreadCount && row.hasUserMention === value.hasUserMention;
    }
  }
}

function retireObservedCommands(
  rows: readonly SidebarSnapshotRow[],
  pending: Readonly<Record<string, PendingSidebarCommand>>,
): Readonly<Record<string, PendingSidebarCommand>> {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  let changed = false;
  const next: Record<string, PendingSidebarCommand> = {};
  for (const [key, command] of Object.entries(pending)) {
    const row = rowById.get(command.threadId);
    if (row && rowObservesCommand(row, command)) {
      changed = true;
      continue;
    }
    next[key] = command;
  }
  return changed ? next : pending;
}

export const useSidebarProjectionStore = create<SidebarProjectionState>((set, get) => ({
  rows: [],
  appliedGeneration: 0,
  hasCanonicalSnapshot: false,
  pendingThreadCommands: {},
  refreshing: false,

  applySidebarSnapshot: (snapshot, requestGeneration, options = {}) => {
    const source = options.source ?? 'server';
    const state = get();
    if (source === 'cache') {
      if (state.hasCanonicalSnapshot) return false;
    } else if (requestGeneration <= state.appliedGeneration) {
      return false;
    }

    const rows = snapshot.map(copySnapshotRow);
    set({
      rows,
      ...(source === 'server' ? { appliedGeneration: requestGeneration, hasCanonicalSnapshot: true } : undefined),
      pendingThreadCommands:
        source === 'server' ? retireObservedCommands(rows, state.pendingThreadCommands) : state.pendingThreadCommands,
    });

    if (source === 'server') {
      void saveSidebarSnapshot(rows).catch(() => {});
    }
    return true;
  },

  beginSidebarCommand: (threadId, field, value) => {
    commandSequence += 1;
    const id = `sidebar-command-${commandSequence}`;
    const key = commandKey(threadId, field);
    set((state) => ({
      pendingThreadCommands: {
        ...state.pendingThreadCommands,
        [key]: { id, threadId, field, value } as PendingSidebarCommand,
      },
    }));
    return id;
  },

  failSidebarCommand: (commandId) => {
    set((state) => {
      const match = Object.entries(state.pendingThreadCommands).find(([, command]) => command.id === commandId);
      if (!match) return state;
      const [key] = match;
      const next = { ...state.pendingThreadCommands };
      delete next[key];
      return { pendingThreadCommands: next };
    });
  },

  clearSidebarCommand: (threadId, field) => {
    const key = commandKey(threadId, field);
    set((state) => {
      if (!state.pendingThreadCommands[key]) return state;
      const next = { ...state.pendingThreadCommands };
      delete next[key];
      return { pendingThreadCommands: next };
    });
  },

  setRefreshing: (refreshing) => set({ refreshing }),
}));

export function projectSidebarRows(
  state: Pick<SidebarProjectionState, 'rows' | 'pendingThreadCommands'>,
): SidebarSnapshotRow[] {
  if (Object.keys(state.pendingThreadCommands).length === 0) return [...state.rows];
  const commandsByThread = new Map<string, PendingSidebarCommand[]>();
  for (const command of Object.values(state.pendingThreadCommands)) {
    const commands = commandsByThread.get(command.threadId) ?? [];
    commands.push(command);
    commandsByThread.set(command.threadId, commands);
  }

  return state.rows.map((row) => {
    const commands = commandsByThread.get(row.id);
    if (!commands) return row;
    let projected = row;
    for (const command of commands) {
      switch (command.field) {
        case 'title':
          projected = { ...projected, title: command.value as string };
          break;
        case 'pinned':
          projected = { ...projected, pinned: command.value as boolean };
          break;
        case 'favorited':
          projected = { ...projected, favorited: command.value as boolean };
          break;
        case 'labels':
          projected = { ...projected, labels: command.value as readonly string[] };
          break;
        case 'preferredCats':
          projected = { ...projected, preferredCats: command.value as readonly string[] };
          break;
        case 'attention': {
          const value = command.value as SidebarCommandValueMap['attention'];
          const hidesTerminalPresence =
            (projected.presence.status === 'done' || projected.presence.status === 'error') &&
            value.unreadCount === 0 &&
            !value.hasUserMention;
          projected = {
            ...projected,
            unreadCount: value.unreadCount,
            hasUserMention: value.hasUserMention,
            presence: hidesTerminalPresence ? { status: 'idle' } : projected.presence,
          };
          break;
        }
      }
    }
    return projected;
  });
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function parseActiveSince(status: SidebarPresenceStatus, value: unknown): { activeSince: number } | undefined {
  if (status !== 'working' || typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return { activeSince: value };
}

/** Strip the wider Thread response down to the C0-C10 boundary before storage. */
export function parseSidebarSnapshotRows(value: unknown): SidebarSnapshotRow[] {
  if (!Array.isArray(value)) return [];
  const rows: SidebarSnapshotRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== 'string') continue;
    const rawPresence =
      raw.presence && typeof raw.presence === 'object' ? (raw.presence as Record<string, unknown>) : {};
    const status = ['idle', 'working', 'done', 'error'].includes(String(rawPresence.status))
      ? (rawPresence.status as SidebarPresenceStatus)
      : 'idle';
    const systemKind = ['connector_hub', 'eval_domain', 'cat_bedroom'].includes(String(raw.systemKind))
      ? (raw.systemKind as SidebarSystemKind)
      : null;
    rows.push({
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title : null,
      participants: strings(raw.participants),
      pinned: raw.pinned === true,
      favorited: raw.favorited === true,
      labels: strings(raw.labels),
      preferredCats: strings(raw.preferredCats),
      projectPath: typeof raw.projectPath === 'string' ? raw.projectPath : 'default',
      lastActiveAt: finiteNumber(raw.lastActiveAt),
      systemKind,
      isHubThread: raw.isHubThread === true || systemKind === 'connector_hub',
      unreadCount: Math.max(0, Math.floor(finiteNumber(raw.unreadCount))),
      hasUserMention: raw.hasUserMention === true,
      presence: {
        status,
        ...(strings(rawPresence.cats).length > 0 ? { cats: strings(rawPresence.cats) } : {}),
        ...parseActiveSince(status, rawPresence.activeSince),
      },
    });
  }
  return rows;
}
