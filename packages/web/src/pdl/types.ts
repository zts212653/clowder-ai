export interface ChatUiState {
  draft?: Record<string, string>;
  workspace?: Record<string, unknown>;
  sendScope?: string;
  sendMode?: string;
  target: string;
  navHidden: boolean;
  viewCat: string | null;
  reply: string | null;
  pop: {
    kind: string;
    page?: string;
    mode?: string;
    typed?: boolean;
    input?: string;
    up?: boolean;
    span?: number;
    fit?: boolean;
    q?: string;
    start?: number;
    end?: number;
    i?: number;
    mid?: string;
    text?: string;
    selection?: MessageQuoteSelection;
    source?: import('@cat-cafe/shared').CliOutputQuoteSource;
    selectionStart?: number;
    selectionEnd?: number;
  } | null;
  find: { q: string; scope: string; sort: string; active: boolean };
  group: string;
  projOpen?: Record<string, boolean>;
  tag: string | null;
  speaking: string | null;
  memberCard?: string | null;
  review?: unknown;
  contentModification?: unknown;
  multi: boolean;
  picked: Record<string, { text: boolean; blocks: Record<string, boolean> }>;
  execOpen: Record<string, boolean>;
  recordExpanded?: boolean;
  editing?: Record<string, boolean>;
  asking?: Record<string, boolean>;
  whisper: boolean;
  whisperTo: string[];
  renaming: boolean;
  queueOpen: boolean;
  clock: number; // the half-minute clock: text that changes with time (the replying line) reads it
  pendingMid?: string;
  lb?: {
    mid: string;
    block: string;
    i: number;
    target?: { kind: 'draftAttachment'; i: number };
    selection?: { x: number; y: number; width?: number; height?: number; at?: number } | null;
    words?: string;
  } | null;
  f: Record<string, unknown>;
  runtime?: { drafts: Record<string, { values: Record<string, unknown> }> };
  modal?: {
    kind: string;
    id?: string;
    to?: string;
    cats: string[];
    messageIds: string[];
    selectionItems?: MessageBundleSelectionItem[];
    busy?: boolean;
    error?: string;
  } | null;
}

export interface SidebarSnapshot extends SidebarSource {
  threads: import('./chat-models').ChatData['threads'];
  /** The thread list's first read is still running. */
  load: string;
  threadId: string;
  executions: import('./chat-models').ChatData['executions'];
  projectPins: string[];
  projectNames: [string, string][];
  timeZone?: string;
}
export interface SidebarDiff {
  added: string[];
  changed: string[];
  removed: string[];
  orderChanged: boolean;
  fields: string[];
}

export interface ChatDiff {
  collections: Record<string, { added: string[]; changed: string[]; removed: string[]; orderChanged: boolean }>;
  fields: string[];
}

export interface ChatPort {
  threadId: string;
  exportMids?: readonly string[] | null;
  exportReady: Promise<void>;
  state: ChatUiState;
  data: Record<string, unknown>;
  sidebarData: SidebarSnapshot;
  needed: (diff: { added: string[]; removed: string[] }) => void;
  action: (name: string, args: Record<string, string>, element?: HTMLElement) => unknown;
  richRender: (kind: string, source: string, inline?: boolean) => Promise<string>;
  terminal: typeof import('./platform').terminal;
  get: (path: string, params?: Record<string, string>) => Promise<unknown>;
  post: (path: string, params: Record<string, string>, body: unknown) => Promise<unknown>;
  file: (path: string) => string;
  attach: (files: File[]) => void;
  navResize: {
    min: number;
    max: () => number;
    width: () => number;
    preview: (width: number) => void;
    commit: (width: number) => void;
    reset: () => void;
  };
}

declare global {
  interface Window {
    clowderChat: {
      start: (port: ChatPort, projections: typeof import('./chat-models').chatModels) => Promise<void>;
      update: (port?: ChatPort) => void;
      pushSidebar: (data: SidebarSnapshot) => SidebarDiff;
      pushProject: (data: Record<string, unknown>) => Record<string, SidebarDiff>;
      pushChat: (data: Record<string, unknown>) => ChatDiff;
      dataError: (source: string, error: unknown) => void;
      dataOk: (source: string) => void;
      confirm: (kind: string, args: Record<string, unknown>) => Promise<boolean>;
      emit: (event: string, data: unknown) => unknown;
    };
  }
}

import type { MessageBundleSelectionItem } from '@cat-cafe/shared';
import type { MessageQuoteSelection } from './message-selection';
import type { SidebarSource } from './useSidebarBindings';
