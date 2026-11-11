import { readFileSync } from 'node:fs';
import { type Context, createContext, runInContext } from 'node:vm';
import { useRef } from 'react';
import { type ChatData, chatModels, evidenceMessageCards } from '../chat-models';
import type { ChatUiState } from '../types';
import { fixtureData, fixtureInput, fixtureUi } from './chat-fixture';
import { ownerInput } from './owner-fixtures';

const application = [
  'workbench-data',
  'planning-data',
  'work-details',
  'content-data',
  'project',
  'project-owners',
  'owner-projections',
].map((name) => readFileSync(`public/pdl-app/${name}.js`, 'utf8'));
const chatSource = readFileSync('public/pdl-app/chat.js', 'utf8');
const chatSnapshotCode = chatSource.slice(
  chatSource.indexOf('let projectionNeeded'),
  chatSource.indexOf('function chatHeldMessages'),
);
const core = readFileSync('public/pdl/engine/core.js', 'utf8');
const clock = core.match(/^function clockText[^\n]+/m)![0];
const projections: Record<string, string> = {
  workbench: 'workbenchModels()',
  execution: 'executionModel(__query)',
  recall: '({cafeWsRecall:recallModel()})',
  terminal: 'terminalModels()',
  home: 'homeModels()',
  recentWorks: 'recentWorksModels()',
  board: 'boardModels()',
  schedule: 'scheduleModels()',
  preview: 'previewModels()',
  replay: 'replayModels()',
  reviews: 'reviewsModels()',
  document: 'documentModels()',
  canon: 'canonModels()',
  film: 'filmModels()',
};

export function fixtureWorkspace() {
  return {
    tkF: 'all',
    q: '',
    qMode: 'all',
    fileMode: 'render',
    gitView: 'status',
    diffMode: 'unified',
    reviewOpen: false,
    review: { target: 'uncommitted', mode: 'session', base: 'origin/main', sha: '', ask: '' },
    tjMode: 'timeline',
    execQ: '',
    pane: 'mine',
    recallFor: null,
    recallExpected: 0,
    execDetail: null,
    scheduleDate: Date.now(),
    scheduleMode: 'month',
    boardV: 'list',
    hbItem: null,
    hbView: 'sug',
    depScope: 'connected',
    node: null,
    zoom: 1,
    pan: [0, 0],
    wk: { q: '', f: 'all', view: 'list', scope: 'thread', group: 'time', cat: '', page: false },
    canon: null,
    film: null,
    clipPreview: null,
  };
}
export function fixtureWorkbenchSource(data: ChatData = fixtureData()) {
  return {
    projectPicker: { browse: null, directories: {}, drives: [], completions: { prefix: '', entries: [] }, setup: {} },
    opened: null,
    fileInfo: { scope: '', load: 'loading' },
    patch: undefined,
    tasks: [],
    fileEdits: {},
    editing: { editMode: false, isTokenValid: false, canEdit: false, saveError: null },
    git: { id: '', load: 'loading' },
    native: { load: 'loading', reviews: [], nativeTargets: [] },
    execution: {
      invocations: {},
      external: { threadId: data.threadId, load: '', sessions: [] },
      externalDetail: null,
      read: { threadId: data.threadId, load: '', sessions: [], runs: [] },
      detail: null,
      search: { threadId: data.threadId, query: '', load: '', hits: [] },
    },
    recall: { threadId: data.threadId, load: '', page: { readStatus: 'ready', nextCursor: null }, events: [] },
    fileSearch: { results: [], loading: false, error: null },
    workspace: { worktreeId: null as string | null, worktrees: [], tree: [], loading: false, error: null },
  };
}
export function fixtureHomeSource() {
  return {
    heldWaits: [],
    waits: { projection: { items: [], candidate: null }, error: null, hydration: 'ready' },
    hydration: 'ready',
    unavailable: [],
    selected: null,
    detail: { id: '', load: '', read: null },
  };
}
export function fixtureTerminalSource(id = 'pty-real') {
  return {
    worktreeId: 'wt',
    load: '',
    available: true,
    mine: { id, output: '', status: 'connected', cols: 80, rows: 24 },
    panes: [],
    outputs: {},
  };
}
type ProjectionOptions = {
  data?: ChatData;
  ui?: ChatUiState;
  ws?: object;
  sources?: Record<string, unknown>;
};

export function createOwnerConsole(options: ProjectionOptions = {}) {
  let chat = options.data ?? fixtureData();
  const ui = options.ui ?? fixtureUi();
  Object.assign(ui, { ...ownerInput(), ...ui });
  const state = options.ws ?? fixtureWorkspace();
  const context = createContext({
    S: { ws: state, pv: {}, popOn: {}, thread: chat.threadId, route: 'chat' },
    CS: ui,
    __ui: ui,
    __chat: fixtureInput(chat).chat,
    chatDataSnapshot: { chat: {}, project: {} },
    chatMessageIndex: new Map(),
    chatStreaming: new Set(),
    sidebarSnapshot: { threads: chat.threads },
    sidebarData: () => ({ threads: chat.threads }),
    api: { on: () => {}, file: (path: string) => new URL(path, 'https://api.test').href },
    URL,
    URLSearchParams,
    Date,
    Intl,
    window: { location: { origin: 'https://pdl.test' } },
    VM: {},
    A: {},
    projectChat: chatModels,
    workKey: (work: { navigationId: string }) => work.navigationId,
    tc: (key: string) => key,
    onStart: () => {},
    render: () => {},
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 1;
    },
    settleHold: <T>(work: Promise<T>) => work,
    navStale: () => {},
    dataError: () => {},
    dataOk: () => {},
    syncChatOwners: () => {},
  });
  runInContext(chatSnapshotCode, context);
  for (const code of application) runInContext(code, context);
  runInContext(clock, context);
  runInContext('chatDataSnapshot={chat:chatDataCopy(__chat),project:{}};', context);
  context.projectSources = (raw = context.chatDataSnapshot.project.sources) =>
    raw.error
      ? {}
      : {
          messageWorks: raw.records.works,
          generations: raw.records.generations,
          evidenceCards: evidenceMessageCards(raw),
        };
  const push = (owners: Record<string, unknown>) => {
    context.__incoming = owners;
    return runInContext('receiveProjectData(__incoming)', context);
  };
  push({ workbench: fixtureWorkbenchSource(chat), ...options.sources });
  const read = (expression: string) => runInContext(expression, context);
  const updateChat = (next: ChatData) => {
    chat = next;
    context.__chat = fixtureInput(next).chat;
    context.sidebarSnapshot = { threads: next.threads };
    runInContext('chatDataSnapshot.chat=chatDataCopy(__chat)', context);
  };
  return { context, push, read, updateChat };
}

/** Test the real classic-console projection after publishing raw hook sources. */
export function useOwnerProjection<T extends { data: unknown; state?: unknown }>(
  owner: string,
  binding: T,
  options: ProjectionOptions = {},
) {
  const ref = useRef<ReturnType<typeof createOwnerConsole>>();
  if (!ref.current) ref.current = createOwnerConsole(options);
  const console = ref.current;
  if (options.data) console.updateChat(options.data);
  if (owner === 'workbench') console.context.S.ws = binding.state;
  if (owner === 'preview') console.context.S.pv = binding.state;
  if (owner === 'reviews') {
    const state = binding.state as { works: unknown; text: unknown };
    console.context.S.ws.wk = state.works;
    console.context.__ui.ws = state.text;
  }
  if (options.ws) console.context.S.ws = options.ws;
  const key = owner === 'execution' || owner === 'recall' ? 'workbench' : owner;
  if (key === 'workbench' && owner !== 'workbench') {
    console.context.__part = binding.data;
    console.push({ workbench: { ...console.read("projectData('workbench')"), [owner]: binding.data } });
  } else console.push({ [key]: binding.data });
  return {
    ...binding,
    console,
    project: (query = '') => {
      console.context.__query = query;
      return console.read(projections[owner]);
    },
  };
}

export function consoleValue(expression: string, globals: Record<string, unknown> = {}) {
  const console = createOwnerConsole();
  Object.assign(console.context, globals);
  return console.read(expression);
}

export type OwnerConsole = ReturnType<typeof createOwnerConsole>;
export type OwnerContext = Context;

export const ownerFunctions = {
  team: 'Team',
  signals: 'Signals',
  evolution: 'Evolution',
  ops: 'Ops',
  evaluation: 'Evaluation',
  voice: 'Voice',
  desktop: 'Desktop',
  sources: 'Sources',
  general: 'General',
  memory: 'Memory',
  memoryExplore: 'MemoryExplore',
  trash: 'Trash',
} as const;
export function ownerConsole(ui: object = {}, data: ChatData = fixtureData()) {
  return createOwnerConsole({ data, ws: ui }).context;
}

export function projectOwner(
  name: keyof typeof ownerFunctions,
  binding: { data: unknown; state?: unknown; editor?: unknown; libraryDraft?: unknown; draft?: unknown },
  ui: object = {},
  data: ChatData | string = fixtureData(),
  fields: Record<string, unknown> = {},
) {
  const context = ownerConsole(ui, typeof data === 'string' ? { ...fixtureData(), threadId: data } : data);
  context.CS.f = fields;
  if (name === 'voice') {
    context.CS.voice = binding.state;
    context.chatDataSnapshot.chat.threadId = (binding.data as { threadId: string }).threadId;
  }
  if (name === 'evaluation') context.CS.evalDuty = binding.state;
  if (name === 'memory')
    Object.assign(context.CS, {
      m: binding.state,
      memoryEdit: binding.editor,
      memoryLibraryDraft: binding.libraryDraft,
    });
  if (name === 'memoryExplore') {
    context.CS.m = ui;
    context.CS.memoryLibraryDraft = binding.draft;
  }
  if (name === 'evolution') context.CS.evolutionReading = binding.state;
  context.receiveProjectData(
    name === 'memoryExplore' ? { memory: { explore: binding.data } } : { [name]: binding.data },
  );
  return context['project' + ownerFunctions[name]]();
}
