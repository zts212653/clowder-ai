// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInContext } from 'node:vm';
import {
  type ApprovalHubItem,
  type ArtifactReviewView,
  type RuntimeInteractionRecord,
  videoProjectDocumentSchema,
  workspaceContentReviewSchema,
} from '@cat-cafe/shared';
import { describe, expect, it, vi } from 'vitest';
import { assetReviewFixture } from '@/components/capability-evolution/__tests__/evolution-asset-fixtures';
import {
  assetRef,
  ownerRef,
  PROGRAM_ID,
  programFixture,
} from '@/components/capability-evolution/__tests__/evolution-fixtures';
import { projectAssetVersions } from '@/components/capability-evolution/evolution-version-view';
import { initial as artworkReviewFixture } from '@/components/content-review/__tests__/review-command.fixture';
import { artifactRoundRequestSource } from '@/components/content-review/artifact-modification-source';
import { CLIENT_OPTIONS, carrierOptionsForClient, initialState } from '@/components/hub-cat-editor.model';
import { model as teamModel } from '@/components/routing-context/__tests__/team-panel-fixtures';
import { apiFetch } from '@/utils/api-client';
import { digest as filmDigest, project as filmDocument } from '../../../../shared/src/__tests__/video-project.fixtures';
import { screening as filmScreening } from '../../../../shared/src/__tests__/video-project-screening.fixtures';
import { chatModels, composerTrigger } from '../chat-models';
import { request } from '../owner-api';
import { scriptSources } from '../runtime';
import { opinionComparison } from '../useFilmBindings';
import { recallSourceRecords } from '../useRecallBindings';
import type { SidebarOwner, SidebarSource } from '../useSidebarBindings';
import { fixtureData, fixtureInput, fixtureSidebar, fixtureUi } from './chat-fixture';
import {
  consoleValue,
  fixtureHomeSource,
  fixtureTerminalSource,
  fixtureWorkbenchSource,
  fixtureWorkspace,
  ownerFunctions,
} from './owner-console';
import { environmentSummaryFixture, ownerData, settingsInput, systemSummaryFixture } from './owner-fixtures';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the jsdom window is loaded untyped
function declaredMenu(w: any, action: string, scope = '') {
  const nodes = Array.from(w.document.querySelectorAll(scope + '[data-menu]')) as HTMLElement[];
  const trigger = nodes.find((el) => {
    const items = w.eval('menuItems(' + JSON.stringify(el.dataset.menu) + ',' + JSON.stringify(el.dataset) + ')');
    return items.some((item: { act: string }) => item.act === action);
  })!;
  expect(trigger).toBeDefined();
  w.menuTrigger = trigger;
  w.eval('A.menu(actionArgs(window.menuTrigger),window.menuTrigger)');
  return w.eval('S.menu.items');
}
const { JSDOM } = createRequire(import.meta.url)('jsdom');
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
type EngineData = Pick<Window['clowderChat'], 'dataError' | 'dataOk'>;
type FixtureApi = {
  get: (path: string, params?: Record<string, string>) => Promise<unknown>;
  post: (path: string, params: Record<string, string>, body: unknown) => Promise<unknown>;
  action: (name: string, args: Record<string, string>, element?: HTMLElement) => unknown;
};

function contentRuntimeFilm(contentRef = 'project', screeningId = 'old') {
  const nextDigest = `sha256:${'b'.repeat(64)}`;
  const original = filmScreening();
  const first = {
    ...original,
    id: screeningId,
    title: 'Old input',
    input: { contentRef, ownerRevision: 1, blobDigest: filmDigest },
    mapping: { ...original.mapping, segments: [{ ...original.mapping.segments[0], mediaStartPts: 7680 }] },
  };
  const second = {
    ...original,
    id: 'new',
    title: 'New input',
    operationId: 'register-new',
    input: { contentRef, ownerRevision: 2, blobDigest: nextDigest },
    mapping: { ...original.mapping, segments: [{ ...original.mapping.segments[0], mediaStartPts: 38400 }] },
  };
  const document = videoProjectDocumentSchema.parse({
    ...filmDocument(),
    title: 'Owner film',
    screenings: [first, second],
    timeline: { ...filmDocument().timeline, scenes: [{ id: 'scene-1', label: 'Common scene' }] },
  });
  const head = { contentRef, ownerRevision: 3, blobDigest: filmDigest, document };
  const review = workspaceContentReviewSchema.parse({
    version: 1,
    reviewId: 'review-film',
    ownerUserId: 'owner',
    contentRef,
    revision: 1,
    source: {
      kind: 'video-project',
      contentRef,
      ownerRevision: 3,
      revision: filmDigest,
      mime: 'application/vnd.cat-cafe.video-project+json',
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    annotations: [first, second].map((screen, index) => ({
      id: index ? 'opinion-new' : 'opinion-old',
      body: index ? 'New opinion' : 'Old opinion',
      state: 'open',
      author: { kind: 'human', actorId: 'owner' },
      anchor: {
        kind: 'video-project',
        baseRevision: screen.input.blobDigest,
        baseOwnerRevision: screen.input.ownerRevision,
        target: { kind: 'project' },
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      replies: [],
      projectHistory: index
        ? undefined
        : [
            {
              kind: 'addressed',
              actor: { kind: 'cat', actorId: 'codex' },
              at: new Date(1).toISOString(),
              operationId: 'addressed',
              result: { contentRef, ownerRevision: 2, blobDigest: nextDigest, operationId: 'render-new' },
            },
          ],
    })),
  });
  const facts = (at: number) => ({
    scenePositions: { 'scene-1': at },
    segmentPositions: { 0: at },
    annotationTimes: {},
  });
  return {
    projects: [head],
    load: '',
    selected: {
      head,
      input: { ...head, ownerRevision: 1 },
      descriptor: { screening: first, mediaUrl: `https://api.test/${screeningId}.mp4` },
      review: {
        ...review,
        annotations: review.annotations.map((annotation) => ({
          ...annotation,
          sourceComparison: opinionComparison(annotation, head),
        })),
      },
      sync: null,
      facts: facts(0.5),
    },
    reference: {
      input: { ...head, ownerRevision: 2, blobDigest: nextDigest },
      descriptor: { screening: second, mediaUrl: 'https://api.test/new.mp4' },
      facts: facts(2.5),
    },
  };
}

function contentRuntimeReviews(view: ArtifactReviewView | null = null) {
  const work = {
    type: 'image',
    name: 'Frozen work',
    catId: 'codex',
    createdAt: 1,
    sourceMessageId: 'source-reply',
    threadId: 'source-thread',
    threadTitle: 'Source owner thread',
    navigationId: 'work-one',
    ref: 'content:work-one',
    url: '/uploads/owner.png',
    work: {
      contentRef: view?.review.contentRef ?? 'work-one',
      ownerRevision: view?.review.rounds.at(-1)!.asset.ownerRevision ?? 3,
      currentOwnerRevision: view?.review.rounds.at(-1)!.asset.ownerRevision ?? 3,
    },
    sourceFacts: {
      content: { kind: 'image' },
      fileSource: { kind: 'url', url: '/uploads/owner.png' },
      fileUrl: 'https://api.test/uploads/owner.png',
      mediaUrl: 'https://api.test/uploads/owner.png',
    },
  };
  return {
    artifacts: { works: [work], complete: true, loading: false, error: false },
    global: { works: [work], artifacts: [work], complete: true, loading: false, error: false },
    recentOwners: [],
    globalEnabled: true,
    widgets: {},
    openedWork: { artifact: work },
    workMetadata: null,
    text: { content: null, loading: false, error: false },
    contexts: [],
    load: '',
    history: { entries: [], nextCursor: null },
    historyLoad: '',
    error: '',
    reviewId: view?.review.reviewId ?? null,
    round: view?.review.rounds.at(-1)?.number ?? null,
    review: view && {
      view,
      round: view.review.rounds.at(-1)!.number,
      src: 'https://api.test/review.png',
      download: 'https://api.test/review.png',
    },
    requestSources: Object.fromEntries(
      (view?.review.rounds ?? []).map((round) => [round.number, artifactRoundRequestSource(view!, round)]),
    ),
    modification: null,
  };
}

async function boot(
  exportMids?: string[],
  prepare?: (data: ReturnType<typeof fixtureData>, ui: ReturnType<typeof fixtureUi>) => void,
  richRenderer?: () => Promise<string>,
  project: Record<string, unknown> | ((engine: EngineData) => Record<string, unknown>) = {},
  setupApi?: (port: FixtureApi) => void,
  local: Record<string, unknown> = {},
  projectSource: Record<string, unknown> = {},
) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: exportMids === undefined ? 'https://pdl.test/' : 'https://pdl.test/?messageId=reply-1#export-pdl-test',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  for (const [key, value] of Object.entries(local))
    w.localStorage.setItem('clowder-proto3:' + key, JSON.stringify(value));
  const errors = vi.spyOn(w.console, 'error').mockImplementation(() => {});
  const theme = readFileSync(path.join(process.cwd(), 'public/pdl/theme/default/pdl.js'), 'utf8');
  w.document.documentElement.style.setProperty(
    '--hold-toast',
    JSON.parse(`[${theme.slice(theme.indexOf('pdlThemeLoad(') + 13, theme.lastIndexOf(')'))}]`)[0].tokens.base[
      '--hold-toast'
    ],
  );
  await new Promise<void>((resolve) => w.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  // jsdom lacks browser rendering APIs; this test verifies DOM/actions, never visual layout.
  w.document.timeline = { currentTime: 0 };
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.CSS = { escape: (s: string) => s, supports: () => true };
  w.HTMLElement.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.showPopover = () => {};
  w.HTMLElement.prototype.hidePopover = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.document.getAnimations = () => [];
  w.document.fonts = { ready: Promise.resolve() };
  for (const source of scriptSources)
    runInContext(readFileSync(path.join(process.cwd(), 'public', source), 'utf8'), dom.getInternalVMContext(), {
      filename: source,
    });
  const terminals = new Map<
    string,
    {
      write: ReturnType<typeof vi.fn>;
      data?: (data: string) => void;
      resize?: (size: { cols: number; rows: number }) => void;
    }
  >();
  w.testTerminal = async (el: HTMLElement) => {
    const terminal = {
      write: vi.fn(),
      data: undefined as ((value: string) => void) | undefined,
      resize: undefined as ((size: { cols: number; rows: number }) => void) | undefined,
    };
    terminals.set(el.dataset.terminal!, terminal);
    return {
      write: terminal.write,
      reset: vi.fn(),
      set: vi.fn(),
      fit: vi.fn(),
      dispose: vi.fn(),
      onData: (fn: (value: string) => void) => {
        terminal.data = fn;
      },
      onResize: (fn: (size: { cols: number; rows: number }) => void) => {
        terminal.resize = fn;
      },
    };
  };
  w.eval('platformProvide({terminal:window.testTerminal})');
  const data = fixtureData(),
    ui = fixtureUi();
  data.forwardingBlocked = false;
  prepare?.(data, ui);
  ui.draft = { 'chat-input': data.input };
  const initial = typeof project === 'function' ? project(w.clowderChat) : project;
  const workspace = (initial.workbenchState ?? {}) as Record<string, unknown>;
  const defaults = fixtureWorkspace();
  for (const [key, value] of Object.entries(defaults)) if (!(key in workspace)) workspace[key] = value;
  const works = initial.worksState ?? workspace.wk;
  workspace.wk = works;
  ui.workspace = {
    workbench: workspace,
    preview: initial.previewState ?? {},
    reviews: { works, text: initial.workTextState ?? { mode: 'render' } },
  };
  const pushClient = { isSupported: false, permission: 'unsupported', isSubscribed: false, worker: 'unsupported' };
  const action = vi.fn<FixtureApi['action']>((name) => (name === 'pushClientRead' ? pushClient : undefined));
  const buildModels = vi.fn(() => {
    throw new Error('VMs must read held data, never the host model builder');
  });
  const sidebarOwner = (typeof project === 'function' ? project(w.clowderChat) : project).sidebarOwner as
    | (SidebarOwner & { classification?: SidebarSource['classification'] })
    | undefined;
  // These renderer cases supply contract VMs; owner-console tests exercise raw receipts and projection.
  const viewFixture = () => (typeof project === 'function' ? project(w.clowderChat) : project);
  Object.assign(ui.voice, viewFixture().voiceState);
  Object.assign(ui.m, viewFixture().memoryState);
  const fixtureVM: Record<string, string> = {
    team: 'cafeWsTeam',
    signals: 'cafeWsSignals',
    evolution: 'cafeWsEvo',
    ops: 'cafeWsOps',
    evaluation: 'eval',
    voice: 'voice',
    desktop: 'desktopSystem',
    sources: 'evidenceCards',
    general: 'systemGeneral',
    memory: 'cafeMemory',
    trash: 'cafeTrash',
  };
  for (const [owner, suffix] of Object.entries(ownerFunctions)) {
    if (['memoryExplore', 'sources'].includes(owner)) continue;
    const original = w['project' + suffix];
    w['project' + suffix] = (raw?: object) => {
      if (raw) return original(raw);
      const views = w.eval('chatDataCopy(chatDataSnapshot.testOwnerViews)');
      return Object.assign(fixtureVM[owner] in views ? {} : original(), views);
    };
  }
  let input: Record<string, unknown> = {
    ...fixtureInput(data),
    project: { ...fixtureInput(data).project, workbench: fixtureWorkbenchSource(data), ...projectSource },
  };
  const port = {
    needed: vi.fn(),
    threadId: data.threadId,
    exportMids,
    exportReady: Promise.resolve(),
    state: ui,
    get data(): Record<string, unknown> {
      input.testOwnerViews = viewFixture();
      return input;
    },
    set data(value: Record<string, unknown>) {
      const project = value.project as Record<string, object>;
      input = {
        ...value,
        project: {
          ...project,
          ...('settings' in project ? { settings: { ...settingsInput(), ...project.settings } } : {}),
        },
      };
    },
    sidebarData: fixtureSidebar(data, {
      owner: sidebarOwner ?? null,
      ...(sidebarOwner?.classification ? { classification: sidebarOwner.classification } : {}),
    }),
    models: buildModels,
    action: action as FixtureApi['action'],
    get: vi.fn<FixtureApi['get']>(async (path: string) =>
      path === '/api/config/env-summary?surface=system'
        ? systemSummaryFixture()
        : path === '/api/config/env-summary'
          ? environmentSummaryFixture()
          : path === '/api/concierge/work/decisions'
            ? { status: 'available', items: [], page: { offset: 0, limit: 20, hasMore: false } }
            : path === '/api/concierge/confirmations'
              ? { confirmations: [] }
              : path === '/api/concierge/thread'
                ? { threadId: null }
                : path === '/api/concierge/work/mentions/last-handling'
                  ? { receipt: null }
                  : path === '/api/config/chat-background'
                    ? { threads: {} }
                    : path === '/api/config/chat-background/images'
                      ? { images: [] }
                      : path === '/api/plugin-manager/plugins'
                        ? { plugins: [] }
                        : path === '/api/plugin-manager/pdl'
                          ? { fragments: {} }
                          : path.startsWith('/api/plugin-manager/pdl/')
                            ? {}
                            : path === '/api/push/status'
                              ? {
                                  capability: {
                                    enabled: false,
                                    vapidPublicKeyConfigured: false,
                                    pushServiceConfigured: false,
                                  },
                                  subscription: { count: 0, targets: [] },
                                  delivery: {
                                    lastResult: 'not_attempted',
                                    lastAttemptAt: null,
                                    lastHttpStatus: null,
                                    lastError: null,
                                  },
                                  errorHints: [],
                                }
                              : undefined,
    ),
    post: vi.fn(async () => undefined),
    file: (s: string) => (s ? new URL(s, 'https://api.test').href : ''),
    richRender: vi.fn(richRenderer ?? (async () => '<math><mi>x</mi></math>')),
    terminal: w.testTerminal,
    navResize: { width: () => 240, min: 160, max: () => 400 },
    mounted: vi.fn(),
    attach: vi.fn(),
    live: () => '',
  };
  function push() {
    if (ui.draft!['chat-input'] !== data.input) {
      ui.draft!['chat-input'] = data.input;
      w.clowderChat.emit('composer:changed', undefined);
    }
    port.data = { ...port.data, chat: fixtureInput(data).chat };
    port.sidebarData = { ...port.sidebarData, ...fixtureSidebar(data, { owner: port.sidebarData.owner }) };
    w.clowderChat.update(port);
  }
  setupApi?.(port);
  const command = port.action;
  port.action = async (...args) => {
    try {
      if (args[0] === 'settingsEnvRead') {
        const env = await port.get('/api/config/env-summary'),
          project = port.data.project as Record<string, object>;
        port.data = { ...port.data, project: { ...project, settings: { ...project.settings, env } } };
        return true;
      }
      if (args[0] === 'settingsSystemRead') {
        const system = await port.get('/api/config/env-summary?surface=system'),
          project = port.data.project as Record<string, object>;
        port.data = { ...port.data, project: { ...project, settings: { ...project.settings, system } } };
        return true;
      }
      if (args[0] === 'settingsPluginsRead') {
        const plugins = await port.get('/api/plugin-manager/plugins'),
          pdl = (await port.get('/api/plugin-manager/pdl')) as { fragments: object };
        const project = port.data.project as Record<string, object>;
        port.data = {
          ...port.data,
          project: { ...project, settings: { ...project.settings, plugins, pluginFragments: pdl.fragments } },
        };
        return true;
      }
      if (args[0] === 'settingsPluginDetailRead') {
        const id = args[1].id,
          response = (await port.get('/api/plugin-manager/plugins/' + encodeURIComponent(id))) as { plugin: object };
        const project = port.data.project as Record<string, object>,
          settings = project.settings as ReturnType<typeof settingsInput>;
        port.data = {
          ...port.data,
          project: {
            ...project,
            settings: {
              ...settings,
              pluginDetails: { ...settings.pluginDetails, [id]: response.plugin },
              pluginLibraries: { ...settings.pluginLibraries, [id]: [] },
            },
          },
        };
        return true;
      }
      return await command(...args);
    } finally {
      push();
    }
  };
  await w.clowderChat.start(port, chatModels);
  if ('desktopUpdateState' in viewFixture())
    w.eval('S.desktopUpdate = chatDataCopy(chatDataSnapshot.testOwnerViews.desktopUpdateState)');
  if (!richRenderer) await w.__settled();
  return { dom, w, data, ui, action, port, errors, buildModels, push, terminals };
}

describe('unmodified runtime and project chat bindings', () => {
  it('applies a restored draft through the local input path and projects the store draft flag', async () => {
    const { dom, w, data, ui, push } = await boot();
    try {
      const input = w.document.getElementById('chat-input');
      data.input = 'restored owner draft';
      ui.draft!['chat-input'] = data.input;
      w.clowderChat.emit('composer:changed', undefined);
      expect(w.document.getElementById('chat-input')).toBe(input);
      expect(input.value).toBe('restored owner draft');
      data.images = [new File(['image'], 'draft.png', { type: 'image/png' })];
      data.contexts = [{ v: 1, id: 'draft-context', kind: 'thread', threadId: 'source', title: 'Draft reference' }];
      data.drafts = { [data.threadId]: true };
      push();
      await w.__settled();
      expect(w.document.getElementById('chat-input').value).toBe('restored owner draft');
      expect(w.eval('VM.chatComposer().input.draft.att[0].name')).toBe('draft.png');
      expect(w.eval('VM.chatComposer().input.draft.ctx[0].title')).toBe('Draft reference');
      expect(
        w.eval(
          'VM.navThreads().sections.flatMap(function(s){return s.rows}).find(function(t){return t.id===S.thread}).draft',
        ),
      ).toBe(true);
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('keeps ordinary typing and draft updates local to the composer without rendering the stream', async () => {
    let source!: ReturnType<typeof fixtureData>, state!: ReturnType<typeof fixtureUi>;
    const { dom, w, push, errors } = await boot(
      undefined,
      (data, ui) => {
        source = data;
        state = ui;
      },
      undefined,
      {},
      (port) => {
        const action = port.action;
        port.action = (name, args, element) => {
          if (name === 'compose') {
            source.input = args.v;
            const pop = composerTrigger(args.v, Number(args.pos));
            if (pop || state.pop?.typed) state.pop = pop;
          }
          return action(name, args, element);
        };
      },
    );
    try {
      const input = w.document.getElementById('chat-input'),
        node = w.document.querySelector('[data-stream] > [data-mid="user-1"]');
      // counts whole-page passes: a composer-only redraw (the local sub-view path) is not one
      w.eval(
        'window.inputRenders=0; var r0=renderAll; window.renderAll=function(){window.inputRenders++; return r0.apply(this, arguments);}',
      );
      input.focus();
      for (const char of 'hello world') {
        input.value += char;
        input.selectionStart = input.selectionEnd = input.value.length;
        input.dispatchEvent(new w.Event('input', { bubbles: true }));
        await w.__settled();
      }
      expect(w.inputRenders).toBe(0);
      expect(source.input).toBe('hello world');
      expect(w.eval('VM.chatComposer().input.value')).toBe('hello world');
      expect(w.document.getElementById('chat-input')).toBe(input);
      expect(input.selectionStart).toBe(11);
      expect(w.document.querySelector('[data-stream] > [data-mid="user-1"]')).toBe(node);
      expect(w.document.querySelector('.composer [data-act="send"]').disabled).toBe(false);
      source.input = 'Programmatic draft';
      push();
      await w.__settled();
      expect(input.value).toBe('Programmatic draft');
      expect(w.inputRenders).toBe(0);
      input.value = '@co';
      input.selectionStart = input.selectionEnd = 3;
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await w.__settled();
      expect(w.inputRenders).toBe(0);
      expect(w.document.querySelector('[data-pop="chat.pop"]')).not.toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('coalesces chat, sidebar and owner arrivals into one frame, while actions stay synchronous', async () => {
    const { dom, w, data, port, errors } = await boot(undefined, (data) => {
      data.messages[1].content = 'Plain reply';
      data.messages[1].toolEvents = [
        {
          id: 'call',
          type: 'tool_use',
          executionRef: 'execution',
          toolUseId: 'tool',
          toolName: 'Read',
          label: 'Read file',
          timestamp: 1,
        },
        {
          id: 'result',
          type: 'tool_result',
          executionRef: 'execution',
          toolUseId: 'tool',
          label: 'Read file',
          detail: 'Read result',
          timestamp: 2,
        },
      ];
      data.activeRuns = [];
      data.executions = [
        {
          executionId: 'live-run',
          threadId: data.threadId,
          threadTitle: 'Public run',
          catId: 'codex',
          kind: 'live_invocation',
          startedAt: 1,
          cancelability: { state: 'not_cancelable', reason: 'control_plane_unavailable' },
        },
      ];
    });
    try {
      const user = w.document.querySelector('[data-stream] > [data-mid="user-1"]'),
        reply = w.document.querySelector('[data-stream] > [data-mid="reply-1"]');
      const runner = w.eval('VM.chatComposer().runners[0]');
      expect(Number.isFinite(runner.seconds)).toBe(true);
      expect(runner.seconds).toBeGreaterThan(0);
      expect(runner.ticking).toBe(true);
      expect(w.document.querySelector('[data-view="chat.composer"]').textContent).not.toContain('NaN');
      // passes that draw something (a render that finds nothing on screen changed draws nothing)
      w.eval(
        'window.drawn=0; var cl=ctLeaf; ctLeaf=function(k,g,d){var was=CT_PIECE[k],r=cl(k,g,d); if(CT_PIECE[k]!==was) window.drew=true; return r;}; var rr=render; render=function(k){window.drew=false; var r=rr(k); if(window.drew) window.drawn++; return r;}',
      );
      w.clowderChat.pushChat({ ...fixtureInput(data).chat, connected: false });
      const owner = { rows: [{ id: 'one', value: 1 }], flags: [] },
        sidebar = { ...port.sidebarData, projectPins: ['/project'] };
      w.clowderChat.pushProject({ arrival: owner });
      w.clowderChat.pushSidebar(sidebar);
      // connection state and project pins are only read off screen (home, an unpinned list): nothing shown changes, nothing draws
      expect(w.eval('drawn')).toBe(0);
      await w.__settled();
      expect(w.eval('drawn')).toBe(0);
      expect(w.document.querySelector('[data-stream] > [data-mid="user-1"]')).toBe(user);
      expect(w.document.querySelector('[data-stream] > [data-mid="reply-1"]')).toBe(reply);
      w.clowderChat.pushProject({ arrival: JSON.parse(JSON.stringify(owner)) });
      const executions = JSON.parse(JSON.stringify(data.executions));
      w.clowderChat.pushChat({ ...fixtureInput(data).chat, connected: false, executions, activeRuns: [] });
      w.clowderChat.pushSidebar({ ...sidebar, executions });
      await w.__settled();
      expect(w.eval('drawn')).toBe(0);
      w.clowderChat.pushChat({
        ...fixtureInput(data).chat,
        messages: [data.messages[0], { ...data.messages[1], content: 'Changed reply' }],
      });
      await w.__settled();
      expect(w.eval('drawn')).toBe(1);
      expect(w.document.querySelector('[data-stream] > [data-mid="user-1"]')).toBe(user);
      expect(w.document.querySelector('[data-stream] > [data-mid="reply-1"]')).not.toBe(reply);
      w.clowderChat.pushProject({ arrival: { rows: [{ id: 'one', value: 2 }] } });
      w.eval("A.set({path:'cs.queueOpen',v:true})");
      // nothing on screen reads this owner or queueOpen: no render pass
      expect(w.eval('drawn')).toBe(1);
      await w.__settled();
      expect(w.eval('drawn')).toBe(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('keeps an empty conversation usable when its reader preference is rejected and reports the source once', async () => {
    const { dom, w, port, errors } = await boot(undefined, (data) => {
      data.messages = [];
    });
    try {
      const error = Object.assign(new Error('Thread not found'), { name: 'PdlReadError' });
      const source = { snapshot: null, error: null, view: null, viewError: error };
      w.clowderChat.pushProject({ general: source });
      await w.__settled();
      expect(w.eval('VM.chatPage().messages.length')).toBe(0);
      expect(w.eval('VM.chatStream().items')).toEqual([]);
      expect(w.document.getElementById('chat-input')).not.toBeNull();
      expect(w.eval('S.toast')).toBe(w.eval('tc("common.dataError")'));
      expect(errors).toHaveBeenCalledTimes(1);
      port.get.mockClear();
      for (let i = 0; i < 10; i++) {
        w.clowderChat.pushProject({ general: source });
        w.eval('VM.chatPage();VM.chatComposer();VM.chatStream()');
      }
      await w.__settled();
      expect(port.get).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('opens declared settings, workspace and preview targets directly for one-shot commands', async () => {
    const { dom, w, action, errors } = await boot();
    try {
      const observed = w.clowderChat.emit('home:inspect', undefined);
      expect(observed).toMatchObject({ route: '/', threadId: 'pdl-test', composer: false });
      expect(observed.sections.map((section: { id: string }) => section.id)).toEqual([
        'members',
        'profiles',
        'accounts',
        'skills',
        'mcp',
        'plugins',
        'marketplace',
        'voice',
        'system',
        'rules',
        'notify',
        'ops',
        'appearance',
      ]);
      expect(
        await w.clowderChat.emit('home:execute', {
          kind: 'navigate',
          action: { kind: 'settings', sectionId: 'appearance' },
        }),
      ).toBe(true);
      expect(w.eval('S.route')).toBe('appearance');
      expect(
        await w.clowderChat.emit('home:execute', {
          kind: 'navigate',
          action: { kind: 'settings', sectionId: 'plugins' },
        }),
      ).toBe(true);
      await w.__settled();
      expect(w.eval('S.route')).toBe('ext');
      expect(
        await w.clowderChat.emit('home:execute', {
          kind: 'navigate',
          action: { kind: 'settings', sectionId: 'notify' },
        }),
      ).toBe(true);
      expect(w.eval('S.route')).toBe('notify');
      expect(w.eval('ROUTE_ANCHOR[S.route]')).toBe('sys-notify');
      expect(
        await w.clowderChat.emit('home:execute', {
          kind: 'navigate',
          action: { kind: 'settings', sectionId: 'concierge' },
        }),
      ).toBe(false);
      expect(
        await w.clowderChat.emit('workspace:navigate', {
          path: 'notes/readme.md',
          worktreeId: 'wt',
          threadId: 'other-thread',
          action: 'reveal',
        }),
      ).toBe(true);
      expect(action).toHaveBeenCalledWith('fileOpen', { p: 'notes/readme.md', w: 'wt' }, undefined);
      expect(w.eval('rtCur("panel")')).toBe('file:' + JSON.stringify(['wt', 'notes/readme.md']));
      expect(w.clowderChat.emit('preview:auto-open', { port: 5173, threadId: 'pdl-test' })).toBe(true);
      expect(w.eval('rtCur("panel")')).toBe('preview');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('projects the held active vote into the declared dock notice and delegates its end action', async () => {
    const { dom, w, port, action, errors } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      {},
      {
        chatOwners: {
          vote: { threadId: 'pdl-test', value: { question: 'Ship?', status: 'active', votes: {}, voteCount: 2 } },
        },
      },
    );
    try {
      expect(
        port.needed.mock.calls
          .flatMap(([diff]) => diff.added)
          .some((source) => source.startsWith('project.chatOwners.vote.')),
      ).toBe(true);
      expect(w.eval('VM.chatPage().vote')).toEqual({ question: 'Ship?', count: 2 });
      const end = w.document.querySelector('[data-act="cafeVoteEnd"]');
      expect(end).not.toBeNull();
      await w.eval('A.cafeVoteEnd()');
      expect(action).toHaveBeenCalledWith('cafeVoteEnd', {}, undefined);
      const project = port.data.project as Record<string, unknown>;
      port.data = {
        ...port.data,
        project: {
          ...project,
          chatOwners: { vote: { threadId: 'other-thread', value: { question: 'Other', status: 'active', votes: {} } } },
        },
      };
      w.clowderChat.update(port);
      expect(w.eval('VM.chatPage().vote')).toBeNull();
      await w.__settled();
      expect(w.document.querySelector('[data-act="cafeVoteEnd"]')).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('diffs the actual projection demand, with no reads from VM inspection, scrolling or an unchanged render', async () => {
    const { dom, w, port, buildModels, errors } = await boot();
    try {
      const bootNeeded = port.needed.mock.calls.flatMap(([diff]) => diff.added);
      expect(bootNeeded).toContain('sidebar');
      expect(bootNeeded).toContain('inbox');
      expect(bootNeeded.some((source) => source.startsWith('project.board'))).toBe(false);
      expect(bootNeeded.some((source) => source.startsWith('project.evaluation'))).toBe(false);
      expect(bootNeeded.some((source) => source.startsWith('project.memory'))).toBe(false);
      port.needed.mockClear();
      port.get.mockClear();
      for (let i = 0; i < 20; i++) w.eval('VM.navThreads();VM.chatStream();');
      w.document.dispatchEvent(new w.Event('scroll'));
      w.document.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
      w.eval('render(true)');
      await w.__settled();
      expect(port.needed).not.toHaveBeenCalled();
      expect(port.get).not.toHaveBeenCalled();
      w.eval("ENGINE_PARTS.openTab('panel','board')");
      await w.__settled();
      expect(
        port.needed.mock.calls.flatMap(([diff]) => diff.added).some((source) => source.startsWith('project.board')),
      ).toBe(true);
      port.needed.mockClear();
      w.eval("A.tab({op:'close',r:'panel',k:'board'})");
      await w.__settled();
      expect(
        port.needed.mock.calls.flatMap(([diff]) => diff.removed).some((source) => source.startsWith('project.board')),
      ).toBe(true);
      port.needed.mockClear();
      w.eval("ENGINE_PARTS.openTab('panel','tasks')");
      await w.__settled();
      const taskReads = port.needed.mock.calls.flatMap(([diff]) => diff.added);
      expect(taskReads).toContain('project.workbench.tasks');
      expect(taskReads.some((source) => source.startsWith('project.workbench.git'))).toBe(false);
      expect(taskReads.some((source) => source.startsWith('project.workbench.execution'))).toBe(false);
      expect(errors).not.toHaveBeenCalled();
      expect(buildModels).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('drops conversation reads when settings or a maximised tool replaces its projection', async () => {
    const { dom, w, port } = await boot();
    try {
      expect(w.eval("[...heldNeeded].some(function (k) { return k.indexOf('chat.messages.') === 0; })")).toBe(true);
      w.eval("go('members')");
      await w.__settled();
      expect(w.eval("[...heldNeeded].filter(function (key) { return key.indexOf('chat.messages.') === 0; })")).toEqual(
        [],
      );
      w.eval("go('chat-pdl-test'); ENGINE_PARTS.openTab('panel','tasks'); S.panelWide=true; render(true)");
      await w.__settled();
      expect(w.eval("[...heldNeeded].some(function (k) { return k.indexOf('chat.messages.') === 0; })")).toBe(false);
      expect(
        port.needed.mock.calls.flatMap(([diff]) => diff.removed).some((k: string) => k.startsWith('chat.messages.')),
      ).toBe(true);
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('applies a full history re-pull by id and retains every unchanged message reference', async () => {
    const { dom, w, data } = await boot();
    try {
      const base = data.messages[0];
      const before = [
        { ...base, id: 'same' },
        { ...base, id: 'removed' },
        { ...base, id: 'running', isStreaming: true, content: 'partial' },
      ];
      w.clowderChat.pushChat({ ...fixtureInput(data).chat, messages: before });
      const held = w.eval('chatDataSnapshot.chat.messages');
      const full = JSON.parse(
        JSON.stringify([
          { ...base, id: 'same' },
          { ...base, id: 'running', isStreaming: false, content: 'complete' },
          { ...base, id: 'added' },
        ]),
      );
      const diff = w.clowderChat.pushChat({ ...fixtureInput(data).chat, messages: full });
      expect(diff.collections.messages).toEqual({
        added: ['added'],
        removed: ['removed'],
        changed: ['running'],
        orderChanged: true,
      });
      const after = w.eval('chatDataSnapshot.chat.messages');
      expect(after[0]).toBe(held[0]);
      expect(after[1]).not.toBe(held[2]);
      expect(after.map((row: { id: string }) => row.id)).toEqual(['same', 'running', 'added']);
      expect(
        w.clowderChat.pushChat({ ...fixtureInput(data).chat, messages: JSON.parse(JSON.stringify(full)) }).collections,
      ).toEqual({});
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('handles a one-shot notification through the existing toast while another source is projected', async () => {
    const { dom, w } = await boot();
    try {
      w.eval("go('members')");
      await w.__settled();
      w.clowderChat.emit('notification:toast', {
        type: 'error',
        title: 'Scheduler',
        message: 'Command receipt',
        action: { label: 'Locate', threadId: 'pdl-test', messageId: 'reply-1' },
      });
      expect(w.document.querySelector('.toast')?.textContent).toBe('Scheduler · Command receiptLocate');
      expect(w.document.querySelector('.toast')?.getAttribute('data-tone')).toBe('danger');
      expect(w.document.querySelector('.toast [data-act="msgJump"]')?.getAttribute('data-mid')).toBe('reply-1');
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('opens an arriving teleport directly from settings without demanding the old conversation first', async () => {
    const { dom, w, action } = await boot();
    try {
      w.eval("go('members')");
      await w.__settled();
      w.clowderChat.emit('thread:teleport', { threadId: 'other-thread', messageId: 'target-message' });
      await w.__settled();
      expect(action).toHaveBeenCalledWith(
        'jump',
        { t: 'other-thread', thread: 'other-thread', mid: 'target-message' },
        undefined,
      );
      expect(w.eval('S.route')).toBe('members');
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('uses the same-origin package image for plugin rows and message identity', async () => {
    const plugin = {
      pluginId: 'dev.icon',
      displayName: 'Icon owner',
      artifact: 'installed',
      intent: 'enabled',
      source: { kind: 'local-archive' },
      actions: {},
      configFields: [],
      icon: { type: 'svg', src: '/api/plugin-manager/plugins/dev.icon/icon' },
    };
    const { dom, w } = await boot(undefined, undefined, undefined, {}, (port) => {
      const get = port.get;
      port.get = (path, params) =>
        path === '/api/plugin-manager/plugins' ? Promise.resolve({ plugins: [plugin] }) : get(path, params);
    });
    try {
      w.eval("go('ext')");
      await w.__settled();
      const icon = w.eval('VM.ext().groups[0].items[0].icon');
      expect(icon).toEqual(plugin.icon);
      expect(w.eval("whoInfo({kind:'plugin',instanceId:'dev.icon'}).img")).toBe(plugin.icon.src);
      expect(w.document.querySelector('[data-view="page.ext"] .glyph img')?.getAttribute('src')).toBe(
        '/api/plugin-manager/plugins/dev.icon/icon',
      );
      w.eval("window.pluginAvatar=whoAva({kind:'plugin',instanceId:'dev.icon'});");
      const avatar = w.document.createElement('div');
      avatar.innerHTML = w.pluginAvatar;
      expect(avatar.querySelector('[data-kind="plugin"][data-img]')?.getAttribute('style')).toContain(
        '--av-img:url("' + plugin.icon.src + '")',
      );
      expect(w.eval("WHO_DATA.plugins()['dev.icon'].name")).toBe('Icon owner');
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('keeps the application inbox state initialized while the held conversation source switches', async () => {
    const { dom, w, port, data, errors } = await boot(undefined, (data) => {
      data.threads.push({ ...data.threads[0], id: 'other-thread' });
    });
    try {
      const inbox = w.eval('CS.ib');
      data.threadId = 'other-thread';
      port.threadId = data.threadId;
      port.data = { ...port.data, chat: fixtureInput(data).chat };
      port.sidebarData = fixtureSidebar(data);
      w.clowderChat.update(port);
      w.eval('A.inboxToggle({},document.getElementById("app"))');
      await w.__settled();
      expect(w.eval('CS.ib')).toBe(inbox);
      expect(w.eval('CS.ib.time')).toBe('week');
      expect(w.document.querySelector('[data-popup="inbox"]')).not.toBeNull();
      expect(w.eval('VM.cafeInbox()')).not.toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('r3b36 work more uses the held work source and ready widget HTML', async () => {
    const reviews = contentRuntimeReviews(),
      widget = {
        type: 'widget',
        name: 'Frozen work',
        catId: 'codex',
        createdAt: 1,
        threadId: 'source-thread',
        navigationId: 'work-one',
        work: reviews.openedWork.artifact.work,
        ref: 'content:widget',
        url: '',
      },
      source = {
        ...reviews,
        artifacts: { ...reviews.artifacts, works: [widget] },
        global: { ...reviews.global, works: [widget] },
        openedWork: null,
        widgets: { 'work-one': { work: widget, state: { status: 'ready', block: { html: '<p>Real widget</p>' } } } },
      };
    const { dom, w, port, buildModels, errors } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      {},
      { reviews: source },
    );
    try {
      await w.eval("A.workOpen({ id:'work-one'})");
      w.eval('render(true)');
      await w.__settled();
      expect(declaredMenu(w, 'download', '[data-view="page.work"] ')).toMatchObject([
        {
          act: 'download',
          data: {
            source: 'data:text/html;charset=utf-8,' + encodeURIComponent('<p>Real widget</p>'),
            name: 'Frozen work',
          },
        },
        { act: 'openUrl', data: { url: 'Frozen work' } },
        { act: 'copy', data: { v: 'Frozen work' } },
      ]);
      expect(w.document.querySelector('[data-pop="menu"]')?.textContent).toContain(w.eval('tc("common.download")'));
      const file = {
        ...reviews.openedWork.artifact,
        sourceFacts: {
          ...reviews.openedWork.artifact.sourceFacts,
          fileSource: { kind: 'workspace', path: 'art/owner.png', worktreeId: 'owner' },
        },
      };
      port.data.project = { reviews: { ...reviews, openedWork: { artifact: file } } };
      w.eval('CS.lb={mid:"",block:"",i:0}');
      w.clowderChat.update(port);
      await w.__settled();
      expect(w.eval('VM.work()')).toMatchObject({
        source: 'https://api.test/uploads/owner.png',
        openPath: 'art/owner.png',
      });
      const download = w.document.querySelector('[data-pop="media"] [data-act="workDownload"]');
      expect(download).not.toBeNull();
      const saved = vi.fn();
      w.savedWork = saved;
      w.eval('PLATFORM.download=window.savedWork');
      download.click();
      expect(saved).toHaveBeenCalledWith('Frozen work', { url: 'https://api.test/uploads/owner.png' });
      expect(buildModels).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('r3b36 vote validates the declared form and waits for the real vote owner without a fake message', async () => {
    const { dom, w, port, errors } = await boot();
    try {
      w.eval('A.dialog({kind:"vote",question:"Ship?"})');
      expect(w.document.getElementById('vote-question').value).toBe('Ship?');
      w.document.getElementById('vote-options').value = 'Only one';
      await w.eval('dialogSubmit()');
      expect(port.post).not.toHaveBeenCalled();
      expect(w.document.getElementById('vote-options')).not.toBeNull();
      w.document.getElementById('vote-options').value = ' Ship \n Wait ';
      w.document.getElementById('vote-anonymous').click();
      w.document.getElementById('vote-timeout').value = '90';
      let finish!: () => void;
      port.post.mockImplementationOnce(
        async () =>
          new Promise<undefined>((resolve) => {
            finish = () => resolve(undefined);
          }),
      );
      const submit = w.eval('dialogSubmit()');
      expect(w.eval('S.dialog')).toBeNull(); // closed while its owner works; the trigger shows progress
      expect(port.post).toHaveBeenCalledWith(
        '/api/threads/pdl-test/vote/start',
        {},
        {
          question: 'Ship?',
          options: ['Ship', 'Wait'],
          anonymous: true,
          timeoutSec: 90,
        },
      );
      finish();
      await submit;
      expect(w.eval('S.dialog')).toBeNull();
      expect(w.eval('VM.chatStream().items.length')).toBe(2);
      w.eval('A.dialog({kind:"vote",question:"Again?"})');
      w.document.getElementById('vote-options').value = 'Yes\nNo';
      port.post.mockRejectedValueOnce(new Error('Vote already active'));
      await w.eval('dialogSubmit()');
      expect(w.document.querySelector('.dialog')?.textContent).toContain('Vote already active');
      expect(w.document.getElementById('vote-question').value).toBe('Again?');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('r3b36 feature modal projects pushed backlog choices and keeps the draft on owner rejection', async () => {
    const { dom, w, data, action, buildModels, errors } = await boot(
      undefined,
      (data) => {
        data.threads[0].backlogItemId = 'backlog-old';
      },
      undefined,
      {},
      undefined,
      {},
      {
        board: {
          items: [
            { id: 'backlog-old', title: 'Prior feature' },
            { id: 'backlog-new', title: 'Next feature' },
          ],
          featureIds: [
            { id: 'backlog-old', featureId: 'F001' },
            { id: 'backlog-new', featureId: 'F002' },
          ],
        },
      },
    );
    try {
      w.eval('A.modal({v:"feature"})');
      expect(w.eval('VM.chatModal().view')).toBe('modal.feature');
      expect(w.document.getElementById('ft-sel').value).toBe('backlog-old');
      expect(w.document.getElementById('ft-sel').textContent).toContain('Next feature');
      const select = w.document.getElementById('ft-sel');
      select.value = 'backlog-new';
      select.dispatchEvent(new w.Event('change', { bubbles: true }));
      action.mockRejectedValueOnce(new Error('Feature owner changed'));
      await w.eval('FORMS.cafeModal()');
      expect(w.document.querySelector('[data-pop="chat.modal"]')?.textContent).toContain('Feature owner changed');
      expect(w.document.getElementById('ft-sel').value).toBe('backlog-new');
      action.mockImplementationOnce(async (_name, args) => {
        data.threads[0].backlogItemId = args.value;
        return true;
      });
      await w.eval('FORMS.cafeModal()');
      expect(action).toHaveBeenLastCalledWith('threadFeatureSave', { id: 'pdl-test', value: 'backlog-new' });
      expect(w.eval('CS.modal')).toBeNull();
      expect(w.eval('sidebarData().threads[0].backlogItemId')).toBe('backlog-new');
      expect(buildModels).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('r3b36 anno real selection trigger submits a quote comment rather than local prototype annotations', async () => {
    const { dom, w, action, errors } = await boot();
    try {
      w.eval(
        'CS.pop={kind:"textsel",mid:"reply-1",text:"消息已接入",selection:{messageId:"reply-1",includeText:true,blockIds:[]}};render(true)',
      );
      w.document.querySelector('[data-act="cafeSel"][data-v="anno"]').click();
      expect(w.document.querySelector('.dialog')).not.toBeNull();
      w.document.getElementById('an-text').value = 'Keep this context';
      w.document.getElementById('an-text').dispatchEvent(new w.Event('input', { bubbles: true }));
      await w.eval('FORMS.cafeModal()');
      expect(action).toHaveBeenCalledWith('messageQuote', {
        op: 'anno',
        selection: JSON.stringify({ messageId: 'reply-1', includeText: true, blockIds: [] }),
        comment: 'Keep this context',
      });
      expect(w.document.querySelector('[data-pop="chat.modal"]')).toBeNull();
      expect(typeof w.eval('MODALS.anno')).toBe('function');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('r3b36 cafeMemRes projects real graph coordinates from a held search row', async () => {
    const owners = ownerData();
    owners.memory.explore.search = {
      key: JSON.stringify(['Needle', 'all', 'summary', 10]),
      load: '',
      data: {
        groups: [
          {
            results: [
              {
                id: 'real-result',
                displayType: 'document',
                title: 'Real memory result',
                snippet: 'Actual source',
                destination: { kind: 'document', anchor: 'actual-anchor', collection: 'actual-collection' },
                graph: { anchor: 'actual-anchor', collection: 'actual-collection' },
              },
            ],
          },
        ],
      },
    } as unknown as typeof owners.memory.explore.search;
    const { dom, w, action, buildModels, errors } = await boot(
      undefined,
      (_data, ui) => {
        Object.assign(ui.m, { view: 'search', searched: 'Needle' });
      },
      undefined,
      {},
      undefined,
      {},
      owners,
    );
    try {
      w.eval('go("memory")');
      await w.__settled();
      expect(w.document.querySelector('[data-view="cafe.memory"]').textContent).toContain('Real memory result');
      expect(w.eval('VM.cafeMemory().search.items[0]')).toMatchObject({
        graph: { anchor: 'actual-anchor', collection: 'actual-collection' },
        act: 'recallSource',
        args: { anchor: 'actual-anchor', collection: 'actual-collection' },
      });
      w.eval('A.set({path:\'cs.m.node|cs.m.view\',v:\'["actual-collection","actual-anchor"]|graph\'})');
      await w.__settled();
      expect(w.eval('CS.m.node')).toBe('["actual-collection","actual-anchor"]');
      expect(w.eval('CS.m.view')).toBe('graph');
      expect(action).toHaveBeenCalledWith('memoryGraphNode', {}, undefined);
      expect(buildModels).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('r3b36 lobby stays demo-only and the real composer plus menu draws no game trigger', async () => {
    const { dom, w, port, action, errors } = await boot();
    try {
      action.mockClear();
      w.document.querySelector('[data-pop="plus"]').click();
      await w.__settled();
      expect(w.document.querySelector('[data-pop="chat.pop"]').textContent).toContain('引用上下文');
      expect(w.eval('VM.chatPop().attachmentFull')).toBe(false);
      expect(w.eval('VM.chatPop().whisperOn')).toBe(false);
      expect(w.document.querySelector('[data-v="lobby"], [data-page="gameMode"]')).toBeNull();
      expect(w.eval('MODALS.lobby')).toBeUndefined();
      expect(w.eval('VM.chatStream().items.length')).toBe(2);
      expect(action).not.toHaveBeenCalled();
      const file = new w.File(['attachment'], 'owner.pdf', { type: 'application/pdf' });
      w.pickAttachment = vi.fn((_accept: string, consume: (file: File) => void) => consume(file));
      w.eval('PLATFORM.pickFile=window.pickAttachment');
      w.document.querySelector('[data-pop="chat.pop"] [data-act="cafeAttach"]').click();
      await w.__settled();
      expect(w.pickAttachment).toHaveBeenCalledWith('', expect.any(Function));
      expect(port.attach).toHaveBeenCalledWith([file]);
      expect(w.eval('CS.pop')).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  const chatPlacementData = () => ({
    proposals: {},
    bundles: {},
    queueTargets: {},
    delivery: {},
    repeatReceipts: {},
    deliveryErrors: {},
    proposalErrors: {},
  });
  it('opens the real queue-target dialog, projects held recipients, and submits their original CAS coordinates', async () => {
    const value = {
      cats: {
        participants: [{ catId: 'codex' }],
        routableNow: [{ catId: 'codex' }, { catId: 'done' }],
        routableNotJoined: [{ catId: 'new' }],
      },
      source: {
        sourceRecordId: 'source',
        targets: [
          { targetCatId: 'codex', actionable: true },
          { targetCatId: 'done', actionable: false },
        ],
      },
    };
    const read = { load: '', value };
    const { dom, w, port, buildModels } = await boot(undefined, undefined, undefined, {}, (port) => {
      const command = port.action;
      port.action = (name, args) => (name === 'queueTargetsRead' ? read : command(name, args));
    });
    try {
      port.data.project = { chatOwners: { ...chatPlacementData(), queueTargets: { '["pdl-test","queue-1"]': read } } };
      w.clowderChat.update(port);
      w.eval("A.queueTargets({entryId:'queue-1'})");
      await w.__settled();
      buildModels.mockClear();
      const vm = w.eval('VM.queueTargets()');
      expect(vm).toMatchObject({ pool: ['codex', 'new'], selected: ['codex'], dispatched: [{ id: 'done' }] });
      expect(buildModels).not.toHaveBeenCalled();
      w.eval("CS.queueTargets.selected=['new'];CS.queueTargets.strategies.new='interrupt_reply'");
      const action = vi.fn(async () => true);
      port.action = action;
      await w.eval('A.queueTargetsSave()');
      expect(action).toHaveBeenCalledWith('queueTargetsSave', {
        threadId: 'pdl-test',
        entryId: 'queue-1',
        value: JSON.stringify({
          sourceRecordId: 'source',
          observedPendingTargetIds: ['codex'],
          targets: [{ targetCatId: 'new', strategy: 'interrupt_reply', membershipAtOpen: 'admit' }],
        }),
      });
      expect(w.eval('S.dialog')).toBeNull();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('gives queue rows stable order keys from the real queue receipt and wires row menus without a second queue read', async () => {
    const { dom, w, port, action, buildModels, errors } = await boot(undefined, (data) => {
      data.queue = [
        {
          id: 'queue-1',
          threadId: 'pdl-test',
          userId: 'owner',
          content: 'Queued',
          messageId: null,
          mergedMessageIds: [],
          from: { kind: 'user', userId: 'owner' },
          targetCats: ['codex'],
          intent: 'send',
          status: 'queued',
          createdAt: 1,
        },
      ];
    });
    try {
      port.data.project = {
        chatOwners: {
          ...chatPlacementData(),
        },
      };
      w.clowderChat.update(port);
      buildModels.mockClear();
      const row = w.eval('VM.chatComposer().queue.items[0]');
      expect(row).toMatchObject({ key: 'queue-1', orderable: true });
      expect(row).toMatchObject({ index: 0, queued: true });
      expect(declaredMenu(w, 'queueTargets')[0].data).toEqual({ entryId: 'queue-1' });
      expect(buildModels).not.toHaveBeenCalled();
      await w.eval("A.cafeQueueOrder({keys:['queue-1']})");
      expect(action).toHaveBeenCalledWith('cafeQueueOrder', { keys: '["queue-1"]' }, undefined);
      w.eval("go('home')");
      const rowMenu = declaredMenu(w, 'rename', '[data-view="nav.threads"] ');
      expect(w.document.querySelector('[data-pop="menu"]')?.textContent).toContain('重命名');
      const copied: string[] = [];
      w.testClipboard = async (value: string) => {
        copied.push(value);
      };
      w.eval('platformProvide({clipboard:window.testClipboard})');
      const copy = rowMenu.find((item: { act: string }) => item.act === 'copy');
      expect(copy.label).toBe(w.eval("tc('wsSessions.copyThreadId')"));
      w.copyArgs = copy.data;
      await w.eval('A.copy(window.copyArgs)');
      expect(copied).toEqual(['pdl-test']);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('projects source-owned proposal decisions and callback menus without reading host models', async () => {
    const revision = `sha256:${'1'.repeat(64)}`;
    const { dom, w, port, action, buildModels } = await boot(
      undefined,
      (data) => {
        data.messages[0].extra = {
          custodyOfferV1: {
            offerId: 'offer',
            sourceMessageRevision: revision,
            policyVersion: 'v1',
            reasonCode: 'entrusted',
            disposition: 'pending',
          },
        };
        data.messages[1].source = { connector: 'callback-auth', label: 'Callback', icon: 'alert' };
        data.messages[1].extra = {
          rich: {
            v: 1,
            blocks: [
              {
                v: 1,
                id: 'cb',
                kind: 'card',
                title: 'Auth',
                meta: {
                  kind: 'callback_auth_failure',
                  reason: 'revoked',
                  tool: 'write',
                  catId: 'codex',
                  threadId: 'pdl-test',
                  userId: 'owner',
                  failedAt: 1,
                },
              },
            ],
          },
        };
      },
      undefined,
      {},
      (port) => {
        const command = port.action;
        port.action = (name, args) => (name === 'proposalOwnerDecide' ? { ok: true } : command(name, args));
      },
    );
    try {
      const source = {
        ...chatPlacementData(),
        proposals: {
          'user-1': {
            load: '',
            value: { offer: { offerId: 'offer', disposition: 'pending' }, sourceMessageRevision: revision },
          },
        },
      };
      port.data.project = { chatOwners: source };
      w.clowderChat.update(port);
      await w.__settled();
      buildModels.mockClear();
      const items = w.eval('VM.chatStream().items');
      expect(items[0]).toMatchObject({
        kind: 'proposal',
        card: {
          decisions: [
            { mid: 'user-1', offerId: 'offer', sourceMessageRevision: revision, v: 'accept' },
            { v: 'refuse' },
          ],
        },
      });
      expect(items[1]).toMatchObject({ kind: 'cbauth', card: { reason: 'revoked' } });
      expect(buildModels).not.toHaveBeenCalled();
      expect(declaredMenu(w, 'cbAuthHideSimilar')).toMatchObject([
        { act: 'cbAuthHideSimilar', data: { mid: 'reply-1' } },
      ]);
      await w.eval("A.cbAuthHideSimilar({mid:'reply-1'})");
      expect(action).toHaveBeenCalledWith('cbAuthHideSimilar', { mid: 'reply-1' });
      w.eval('window.ownerRenders=0;onRender(function(){window.ownerRenders++;});');
      buildModels.mockClear();
      port.data.project = { chatOwners: source };
      w.clowderChat.update(port);
      expect(w.ownerRenders).toBe(0);
      expect(buildModels).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('opens and retries the message-bundle chip with held source content and tombstones', async () => {
    const { dom, w, port, action, buildModels } = await boot(undefined, (data) => {
      data.messages[0].extra = {
        messageBundle: { v: 1, sourceThreadId: 'source-thread', items: [{ kind: 'message', messageId: 'original' }] },
      };
    });
    try {
      port.data.project = {
        chatOwners: {
          ...chatPlacementData(),
          bundles: {
            'user-1': {
              load: '',
              value: {
                items: [
                  {
                    status: 'available',
                    from: { kind: 'user', userId: 'owner' },
                    timestamp: 1,
                    readableContent: 'Resolved source quote',
                    comment: 'Comment',
                  },
                  { status: 'tombstone', messageId: 'removed', reason: 'source_changed' },
                ],
              },
            },
          },
        },
      };
      w.clowderChat.update(port);
      await w.eval("A.messageBundleOpen({id:'user-1'})");
      expect(action).toHaveBeenCalledWith('messageBundleOpen', { id: 'user-1' }, undefined);
      buildModels.mockClear();
      expect(w.eval('VM.chatStream().items[0].embeds.find(x=>x.bundle).bundle')).toMatchObject({
        open: true,
        items: [
          { readableContent: 'Resolved source quote', comment: 'Comment', status: 'available' },
          { status: 'tombstone', messageId: 'removed', reason: 'source_changed' },
        ],
      });
      expect(buildModels).not.toHaveBeenCalled();
      action.mockClear();
      await w.eval("A.messageBundleOpen({id:'user-1'})");
      expect(action).not.toHaveBeenCalled();
      expect(w.eval('VM.chatStream().items[0].embeds.find(x=>x.bundle).bundle.open')).toBe(false);
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('opens delivery recovery from the receipt and keeps retry, repeat and partial reads separate', async () => {
    const { dom, w, port, action, buildModels } = await boot(undefined, (data) => {
      data.messages[0].lifecycle = {
        kind: 'input',
        orderKey: '1:user-1',
        dispatchRefs: [{ targetId: 'codex', phase: 'dispatched', dispatchedAt: 1, statusMessageId: 'failure' }],
      };
    });
    try {
      port.data.project = {
        chatOwners: {
          ...chatPlacementData(),
          delivery: { '["pdl-test","user-1"]': { codex: { load: '', value: { status: 'failed' } } } },
        },
      };
      w.clowderChat.update(port);
      const receipt = w.eval('VM.chatStream().items[0].delivery[0]');
      expect(receipt.open).toEqual({ act: 'cafeDelivery', args: { threadId: 'pdl-test', sourceMessageId: 'user-1' } });
      await w.eval("A.cafeDelivery({threadId:'pdl-test',sourceMessageId:'user-1'})");
      await w.__settled();
      buildModels.mockClear();
      expect(w.eval('VM.chatPop().delivery.items[0]')).toMatchObject({
        who: 'codex',
        canRetry: true,
        canRepeat: false,
        noReply: true,
      });
      expect(buildModels).not.toHaveBeenCalled();
      expect(action).toHaveBeenCalledWith(
        'cafeDeliveryRead',
        { threadId: 'pdl-test', sourceMessageId: 'user-1', targets: '["codex"]' },
        undefined,
      );
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('anchors delivery to a generic component and accepts a trigger outside a content container', async () => {
    const { dom, w } = await boot();
    try {
      w.eval(
        'window.anchors=[];window.originalSpot=spotOpen;spotOpen=function(mode,host,rect,open){window.anchors.push([mode,host]);open(null);};A.cafeDeliveryRead=function(){};',
      );
      const host = w.document.createElement('section'),
        trigger = w.document.createElement('button');
      host.setAttribute('data-c', 'example');
      host.append(trigger);
      w.document.body.append(host);
      w.deliveryTrigger = trigger;
      w.eval("A.cafeDelivery({threadId:'pdl-test',sourceMessageId:'user-1'},window.deliveryTrigger)");
      expect(w.anchors).toEqual([['point', host]]);
      const outside = w.document.createElement('button');
      w.document.body.append(outside);
      w.deliveryTrigger = outside;
      w.eval("A.cafeDelivery({threadId:'pdl-test',sourceMessageId:'user-1'},window.deliveryTrigger)");
      expect(w.anchors).toHaveLength(1);
      expect(w.eval('CS.pop.sourceMessageId')).toBe('user-1');
    } finally {
      dom.window.close();
    }
  });
  it('applies guide admission from backend data and sends all lifecycle actions to the real owner', async () => {
    const { dom, w, port, action } = await boot();
    try {
      port.data.project = {
        chatOwners: {
          ...chatPlacementData(),
          onboarding: { demo: { status: 'completed', autoEligible: false }, entry: { status: 'pending' } },
        },
      };
      w.clowderChat.update(port);
      expect(w.eval('S.popOn.guide')).toBe(false);
      expect(w.eval('S.popOn.nativeSetup')).toBe(true);
      const command = action.getMockImplementation()!;
      action.mockImplementation((name, args, el) =>
        name === 'guideNext' ? { status: 'pending' } : command(name, args, el),
      );
      for (const name of ['guideAdmission', 'guideDismiss', 'guideNext', 'guideEntryDismiss', 'guideEntryComplete']) {
        await w.eval(`A.${name}()`);
        expect(action).toHaveBeenCalledWith(name, {}, undefined);
      }
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('restores the backend inbox undo receipt and rechecks batch-ignore coverage before saving', async () => {
    let receipt: { undoId: string; remaining: number } | null = { undoId: 'undo-1', remaining: 2 };
    let revision = 3;
    const requests = [
      {
        threadId: 'source-thread',
        messageId: 'mentioned',
        expectedRevision: 2,
        preferenceCoordinate: { kind: 'mention', threadId: 'source-thread', messageId: 'mentioned' },
      },
    ];
    const { dom, w, port, action, buildModels } = await boot(undefined, undefined, undefined, {}, (port) => {
      const get = port.get;
      port.get = vi.fn(async (path, params) =>
        path === '/api/concierge/work/mentions/last-handling'
          ? { receipt }
          : path === '/api/concierge/work/mentions/handling-preview'
            ? {
                period: 'week',
                ownerUserId: 'owner',
                requests,
                coverage: { state: 'complete' },
                consistency: { state: 'verified' },
                personalView: { preferenceRevision: revision, ignoredCount: 1 },
              }
            : get(path, params),
      );
      port.post = vi.fn(async (path) => {
        if (path.endsWith('/undo')) receipt = null;
        return {};
      });
    });
    try {
      expect(w.eval('VM.cafeInbox().undoReceipt')).toEqual({ undoId: 'undo-1', remaining: 2 });
      await w.eval("A.cafeIbUndo({undoId:'undo-1'})");
      expect(port.post).toHaveBeenCalledWith('/api/concierge/work/mentions/undo', {}, { undoId: 'undo-1' });
      expect(w.eval('VM.cafeInbox().undoReceipt')).toBeNull();
      await w.eval("A.modal({v:'ibIgnore'})");
      buildModels.mockClear();
      expect(w.eval('VM.chatModal().view')).toBe('modal.ibIgnore');
      expect(w.eval('VM.chatModal().submission.disabled')).toBeFalsy();
      expect(buildModels).not.toHaveBeenCalled();
      revision = 4;
      expect(await w.eval('FORMS.cafeModal()')).toBe(false);
      expect(w.eval('CS.modal.error')).toBeTruthy();
      expect(action.mock.calls.filter(([name]) => name === 'inboxIgnore')).toHaveLength(0);
      expect(await w.eval('FORMS.cafeModal()')).toBe(true);
      expect(action).toHaveBeenCalledWith('inboxIgnore', {
        value: JSON.stringify({
          expectedOwnerUserId: 'owner',
          expectedRevision: 4,
          ignore: [requests[0].preferenceCoordinate],
          restore: [],
        }),
      });
      expect(w.eval('CS.modal')).toBeNull();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('opens the source-specific disposition and clears only that filter, with the real source owner', async () => {
    const page = { bundles: [{ bundleKey: 'only-bundle' }] };
    const { dom, w } = await boot(undefined, undefined, undefined, {}, (port) => {
      const command = port.action;
      port.action = (name, args) => (name === 'msgDisposition' ? { messageId: args.mid, page } : command(name, args));
    });
    try {
      w.eval('window.opened=[];ENGINE_PARTS.openTab=function(region,key){window.opened.push([region,key]);}');
      await w.eval("A.msgDisposition({mid:'user-1'})");
      expect(w.eval('S.ws.pawSource')).toEqual({ messageId: 'user-1', page });
      expect(w.eval('S.ws.pawF')).toBe('all');
      expect(w.eval("S.folds['row:paw']")).toBe('only-bundle');
      expect(w.opened).toEqual([['panel', 'eval']]);
      w.eval('A.pawSourceClear()');
      expect(w.eval('S.ws.pawSource')).toBeNull();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('confirms before revealing whispers and sends candidate undo to its original writer', async () => {
    const { dom, w, action } = await boot(undefined, undefined, undefined, { memoryState: { lib: 'done' } });
    try {
      w.eval("A.cafeReveal({id:'pdl-test'})");
      await w.eval('S.dialog.on()');
      expect(action).toHaveBeenCalledWith('cafeReveal', { id: 'pdl-test' });
      await w.eval("A.cafeCandUndo({id:'marker-1'})");
      expect(action).toHaveBeenCalledWith('cafeCandUndo', { id: 'marker-1' }, undefined);
      expect(w.eval('CS.m.lib')).toBe('pending');
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('switches real evolution details from held programs through direct navigation without another owner pull', async () => {
    const a = programFixture(),
      b = programFixture();
    a.program.displayName = 'Held program A';
    b.program.programId = 'held-program-b';
    b.program.displayName = 'Held program B';
    const state = { evoId: null as string | null, evoReading: {}, sigView: 'list' };
    const raw = {
      ...ownerData().evolution,
      query: { programs: [a, b], loading: false, error: null, rejected: null },
      exact: { id: a.program.programId, projection: a, loading: false, error: null },
      assets: { programId: a.program.programId, loading: false, error: null },
    };
    const { dom, w, action } = await boot(undefined, undefined, undefined, { workbenchState: state }, (commands) => {
      Object.assign(commands, {
        data: { ...fixtureInput(fixtureData()), project: { ...ownerData(), evolution: raw } },
      });
    });
    try {
      w.eval("ENGINE_PARTS.openTab('panel', 'evolution')");
      await w.__settled();
      action.mockClear();
      for (const program of [a, b]) {
        w.eval(
          "navOpen({ f: navTop(navTabKey('panel', 'evolution')).f, a: { sub: " +
            JSON.stringify(program.program.programId) +
            " }, into: navTabKey('panel', 'evolution'), push: true, title: 'Evolution' })",
        );
        await w.__settled();
        const view = w.document.querySelector('[data-view="cafe.ws.evolution"]');
        expect(view?.textContent).toContain(program.program.displayName);
        expect(view?.textContent).not.toContain(program === a ? b.program.displayName : a.program.displayName);
        expect(
          w.eval(
            "navWith(navTabKey('panel', 'evolution'), navTop(navTabKey('panel', 'evolution')), function () { return VM.cafeWsEvo().load; })",
          ),
        ).toBe('');
      }
      expect(action.mock.calls.some(([name]) => name === 'evolutionOpen')).toBe(false);
    } finally {
      dom.window.close();
    }
  });
  it('projects the held voice service notice without changing the chat owner model across repeated reads', async () => {
    const { dom, w } = await boot();
    try {
      w.clowderChat.pushProject({ voice: { ...ownerData().voice, services: { load: '', items: [] } } });
      await w.__settled();
      const count = w.eval("chatRead('chatComposer').notices.length");
      for (let i = 0; i < 100; i++) expect(w.eval('projectVoice().composerVoice.service.state')).toBe('none');
      expect(w.eval("chatRead('chatComposer').notices.length")).toBe(count);
    } finally {
      dom.window.close();
    }
  });

  it.each([
    'messages',
    'queue',
    'questions',
    'cats',
    'contexts',
  ] as const)('holds %s by id, ignores an unchanged push and projects without a host model read', async (owner) => {
    const record: RuntimeInteractionRecord = {
      request: {
        version: 1,
        kind: 'question',
        interactionId: 'question-1',
        owner: { userId: 'owner', threadId: 'pdl-test', catId: 'codex', invocationId: 'turn-1' },
        provider: { providerId: 'codex', method: 'question', requestId: 'request-1' },
        createdAt: 1,
        title: 'Original question',
        questions: [{ id: 'answer', header: 'Answer', question: 'Choose', isSecret: false }],
      },
      source: {
        kind: 'provider_request',
        provider: { providerId: 'codex', method: 'question', requestId: 'request-1' },
      },
      returnBinding: { kind: 'provider_waiter' },
      status: 'pending',
      hostEpoch: 'epoch',
      revision: 1,
      cardRef: { threadId: 'pdl-test', messageId: 'reply-1', blockId: 'block-1' },
      updatedAt: 1,
    };
    const { dom, w, data, ui, buildModels, errors } = await boot(undefined, (data, ui) => {
      data.queue = [
        {
          id: 'queue-1',
          threadId: 'pdl-test',
          userId: 'owner',
          content: 'Original queue',
          messageId: null,
          mergedMessageIds: [],
          from: { kind: 'user', userId: 'owner' },
          targetCats: ['codex'],
          intent: 'send',
          status: 'queued',
          createdAt: 1,
        },
      ];
      data.contexts = [
        {
          v: 1,
          id: 'context-1',
          kind: 'quote',
          text: 'Original quote',
          source: { kind: 'message', threadId: 'pdl-test', messageId: 'user-1' },
        },
      ];
      data.questions = {
        'question-1': {
          record,
          current: true,
          refresh: async () => {
            throw new Error('VM must not refresh');
          },
        },
      };
      data.messages[1].extra = {
        runtimeInteractionCard: {
          version: 1,
          interactionId: 'question-1',
          blockId: 'block-1',
          requestKind: 'question',
        },
      };
      ui.memberCard = 'codex';
    });
    try {
      w.eval(
        'window.ownerRenders=0;onRender(function(){window.ownerRenders++;});window.heldFirst=chatDataSnapshot.chat.messages[0];',
      );
      const unchanged = w.eval('chatDataSnapshot.chat');
      buildModels.mockClear();
      const empty = w.clowderChat.pushChat(unchanged);
      expect(empty).toEqual({ collections: {}, fields: [] });
      expect(w.ownerRenders).toBe(0);
      expect(buildModels).not.toHaveBeenCalled();
      if (owner === 'messages') data.messages[1].content = 'Changed message';
      if (owner === 'queue') data.queue[0].content = 'Changed queue';
      if (owner === 'questions')
        data.questions['question-1'].record = {
          ...record,
          revision: 2,
          request: { ...record.request, title: 'Changed question' },
        };
      if (owner === 'cats') data.cats[0].displayName = 'Changed member';
      if (owner === 'contexts')
        data.contexts[0] = {
          v: 1,
          id: 'context-1',
          kind: 'quote',
          text: 'Changed quote',
          source: { kind: 'message', threadId: 'pdl-test', messageId: 'user-1' },
        };
      const next = fixtureInput(data).chat;
      const diff = w.clowderChat.pushChat(next);
      expect(diff).toEqual({
        collections: {
          [owner]: {
            added: [],
            changed: [
              { messages: 'reply-1', queue: 'queue-1', questions: 'question-1', cats: 'codex', contexts: 'context-1' }[
                owner
              ],
            ],
            removed: [],
            orderChanged: false,
          },
        },
        fields: [],
      });
      await w.__settled();
      expect(w.ownerRenders).toBe(1);
      expect(w.eval('chatDataSnapshot.chat.messages[0]===window.heldFirst')).toBe(true);
      buildModels.mockClear();
      for (let i = 0; i < 20; i++) {
        w.eval(
          'VM.chatHeader();VM.chatPage();VM.chatComposer();VM.chatStream();VM.chatPop();VM.memberCard();WHO_DATA.members();WHO_DATA.me();',
        );
      }
      expect(buildModels).not.toHaveBeenCalled();
      if (owner === 'messages') expect(w.eval('VM.chatStream().items[1].md')).toBe('Changed message');
      if (owner === 'queue') expect(w.eval('VM.chatComposer().queue.items[0].text')).toBe('Changed queue');
      if (owner === 'questions') expect(w.eval('VM.chatStream().items[1].card.title')).toBe('Changed question');
      if (owner === 'cats') expect(w.eval('VM.memberCard().rows[0].name')).toBe('Changed member');
      if (owner === 'contexts') expect(w.eval('VM.chatComposer().input.draft.ctx[0].text')).toBe('Changed quote');
      // Selection is console UI state: a VM projects it without requesting data or models.
      ui.multi = true;
      ui.picked['reply-1'] = { text: true, blocks: {} };
      expect(w.eval('VM.chatStream().items[1].picked')).toBe(true);
      expect(buildModels).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('docks the single home composer after recent works while either declared preview is open', async () => {
    const { dom, w, buildModels } = await boot(
      undefined,
      (data) => {
        data.threadId = 'default';
      },
      undefined,
      {},
      undefined,
      {},
      { recentWorks: { projectId: null, load: 'empty', artifacts: [] } },
    );
    try {
      const home = w.document.createElement('div');
      for (const [preview, state] of [
        [false, 'CS.lb=null;S.ws.clipPreview=null;'],
        [true, 'CS.lb={i:0};'],
        [true, 'CS.lb=null;S.ws.clipPreview={id:"clip"};'],
        [false, 'S.ws.clipPreview=null;'],
      ] as const) {
        w.eval(state);
        expect(w.eval('VM.cafeHome().preview')).toBe(preview);
        home.innerHTML = w.eval("pdlView('cafe.home')");
        const composer = home.querySelector('[data-view="chat.composer"]'),
          recent = home.querySelector('[data-view="works.recent"]');
        expect(home.querySelectorAll('#chat-input')).toHaveLength(1);
        expect(Boolean(recent.compareDocumentPosition(composer) & w.Node.DOCUMENT_POSITION_FOLLOWING)).toBe(preview);
      }
      expect(buildModels).not.toHaveBeenCalled();
    } finally {
      w.eval('CS.lb=null;S.ws.clipPreview=null;');
      dom.window.close();
    }
  });
  it('uses the project path menus and retains a rejected clone URL in the existing async dialog', async () => {
    const { dom, w, action } = await boot();
    try {
      w.eval(
        "window.projectComposer=VM.chatComposer;VM.chatComposer=function(){return Object.assign({},window.projectComposer(),{preflight:{path:'/project with spaces',git:{available:true,off:false},index:{state:'missing',busy:false}}});};render(true)",
      );
      const gitMenu = declaredMenu(w, 'cafeProjectClone');
      expect(gitMenu.map((item: { act: string; data: unknown }) => [item.act, item.data])).toEqual([
        ['cafeProjectPrepare', { path: '/project with spaces', op: 'init' }],
        ['cafeProjectClone', { path: '/project with spaces' }],
      ]);
      w.eval('S.menu=null;render(true)');
      const indexMenu = (Array.from(w.document.querySelectorAll('[data-menu]')) as HTMLElement[])
        .map((el): { act: string; data: { op?: string } }[] =>
          w.eval('menuItems(' + JSON.stringify(el.dataset.menu) + ')'),
        )
        .find((items) => items.some((item) => item.act === 'cafeProjectPrepare' && item.data.op === 'later'))!;
      expect(indexMenu.map((item: { act: string; data: unknown }) => [item.act, item.data])).toEqual([
        ['cafeProjectPrepare', { path: '/project with spaces', op: 'start' }],
        ['cafeProjectPrepare', { path: '/project with spaces', op: 'later' }],
      ]);
      let reject = true;
      action.mockImplementation((name) => {
        if (name === 'cafeProjectClone' && reject) throw new Error('clone_refused');
        return true;
      });
      w.eval("A.cafeProjectClone({path:'/project with spaces'})");
      w.document.getElementById('dlg-in').value = 'https://git.test/repo.git';
      await w.eval('dialogSubmit(S.dialog)');
      expect(w.document.querySelector('.dialog').textContent).toContain('clone_refused');
      expect(w.document.getElementById('dlg-in').value).toBe('https://git.test/repo.git');
      reject = false;
      await w.eval('dialogSubmit(S.dialog)');
      expect(action).toHaveBeenLastCalledWith('cafeProjectClone', {
        path: '/project with spaces',
        gitCloneUrl: 'https://git.test/repo.git',
      });
      expect(w.eval('S.dialog')).toBeNull();
    } finally {
      dom.window.close();
    }
  });
  it('returns a work preview or widget tab to its conversation through the real draft action', async () => {
    const { dom, w, ui, action } = await boot();
    try {
      ui.lb = { mid: '', block: '', i: 0 };
      w.eval('go("works");projectWorks["work:3"]="widget-owner"');
      await w.eval('A.cafeWorkSrc({i:3})');
      expect(action).toHaveBeenCalledWith('cafeWorkSrc', { id: 'widget-owner' }, undefined);
      expect(w.eval('S.route')).toBe('chat');
      expect(ui.lb).toBeNull();
      action.mockClear();
      await w.eval('A.cafeWorkSrc({i:99})');
      expect(action).toHaveBeenCalledWith('cafeWorkSrc', {}, undefined);
    } finally {
      dom.window.close();
    }
  });
  it('projects r144 project status buttons and directory completions from held reads and picks the declared path', async () => {
    const directory = {
      current: '/project',
      parent: null,
      entries: [{ name: 'sub', path: '/project/sub', isDirectory: true }],
    };
    const picker = {
      browse: directory,
      directories: { '/project': directory },
      drives: [],
      completions: {
        prefix: '/pro',
        entries: [
          { name: 'sub', path: '/project/sub', isDirectory: true },
          { name: 'file', path: '/project/file', isDirectory: false },
        ],
      },
      setup: {
        '/project': {
          load: '',
          directory: { isEmptyDir: true, isGitRepo: false, gitAvailable: true },
          index: { status: 'missing', snoozed_until: null as string | null, error_message: null },
        },
        '/project/sub': { load: 'error' },
      },
    };
    const bench = { ...fixtureWorkbenchSource(), projectPicker: picker };
    const { dom, w, action, buildModels, errors } = await boot(
      undefined,
      (data) => {
        data.threadId = 'default';
        data.newProjectId = '/project';
      },
      undefined,
      {},
      undefined,
      {},
      { workbench: bench },
    );
    try {
      w.eval("CS.pop={kind:'projPick',page:'browse'};CS.ppRoot='/project';CS.f['pp-path']='/pro';render(true)");
      const read = () => w.eval('VM.chatPop()');
      expect(read().browse.completions).toEqual([{ name: 'sub', path: '/project/sub' }]);
      expect(w.eval('VM.chatComposer().preflight')).toMatchObject({
        path: '/project',
        git: { available: true, off: false },
        index: { state: 'missing', busy: false },
      });
      buildModels.mockClear();
      for (let i = 0; i < 30; i++) {
        read();
        w.eval('VM.chatComposer()');
      }
      expect(buildModels).not.toHaveBeenCalled();
      picker.setup['/project'].directory.isGitRepo = true;
      expect(w.eval('VM.chatComposer().preflight.git.off')).toBe(false);
      w.clowderChat.pushProject({ workbench: bench });
      expect(w.eval('VM.chatComposer().preflight.git')).toBeNull();
      const index = picker.setup['/project'].index;
      for (const [status, busy] of [
        ['missing', false],
        ['stale', false],
        ['failed', false],
        ['building', true],
      ] as const) {
        index.status = status;
        w.clowderChat.pushProject({ workbench: bench });
        expect(w.eval('VM.chatComposer().preflight.index')).toMatchObject({ state: status, busy });
      }
      index.snoozed_until = '2099-01-01T00:00:00Z';
      w.clowderChat.pushProject({ workbench: bench });
      expect(w.eval('VM.chatComposer().preflight')).toBeNull();
      index.snoozed_until = null;
      index.status = 'ready';
      w.clowderChat.pushProject({ workbench: bench });
      expect(w.eval('VM.chatComposer().preflight')).toBeNull();
      action.mockImplementation((name) => (name === 'projectBrowse' ? { directory } : {}));
      await w.eval("A.cafePathPick({path:'/project/sub'})");
      expect(w.eval("[CS.ppRoot,CS.ppPick,CS.f['pp-path']]")).toEqual(['/project/sub', '/project/sub', '/project/sub']);
      expect(w.eval("S.folds['tree:ppTree']")).toEqual({});
      w.document.getElementById('pp-path').value = '/next';
      w.document.getElementById('pp-path').dispatchEvent(new w.Event('input', { bubbles: true }));
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith('cafePathComplete', { prefix: '/next', cwd: '/project/sub' }, undefined),
      );
      await w.eval("A.cafeProjectPrepare({path:'/project/sub',op:'init'})");
      expect(action).toHaveBeenCalledWith('cafeProjectPrepare', { path: '/project/sub', op: 'init' }, undefined);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('reads current and background member status from held data and indexes live messages only when they change', async () => {
    const { dom, w, data, buildModels } = await boot(undefined, (data) => {
      data.messages[1].isStreaming = true;
      data.live = { 'pdl-test': { codex: 'streaming' }, background: { codex: 'pending' } };
    });
    try {
      buildModels.mockClear();
      expect(w.eval("WHO_DATA.live('codex','reply-1')")).toBe('streaming');
      expect(w.eval("WHO_DATA.live('codex','user-1')")).toBe('');
      expect(w.eval("WHO_DATA.threadLive('background','codex')")).toBe('pending');
      expect(buildModels).not.toHaveBeenCalled();
      w.eval('window.heldLiveIndex=chatMessageIndex;');
      data.live!.background = { codex: 'done' };
      const diff = w.clowderChat.pushChat(fixtureInput(data).chat);
      expect(diff).toEqual({
        collections: { live: { added: [], changed: ['background'], removed: [], orderChanged: false } },
        fields: [],
      });
      expect(w.eval('chatMessageIndex===window.heldLiveIndex')).toBe(true);
      buildModels.mockClear();
      expect(w.eval("WHO_DATA.threadLive('background','codex')")).toBe('');
      expect(buildModels).not.toHaveBeenCalled();
      data.messages[1].isStreaming = false;
      data.activeRuns = [{ responseMessageId: 'reply-1' } as never];
      w.clowderChat.pushChat(fixtureInput(data).chat);
      expect(w.eval("WHO_DATA.live('codex','reply-1')")).toBe('streaming');
      data.activeRuns = [];
      w.clowderChat.pushChat(fixtureInput(data).chat);
      expect(w.eval("WHO_DATA.live('codex','reply-1')")).toBe('');
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('registers r141 recovery and reflux menus and waits for the force-reset confirmation', async () => {
    const board = {
      items: [],
      featureIds: [],
      sopDefinition: { stages: [] },
      read: { load: '' },
      docs: {},
      threads: [],
      projects: [],
      projectsLoad: '',
      external: { id: 'project-owner', load: '' },
      riskResults: null,
      sop: { id: '', value: null, load: '' },
      browsing: false,
      dialog: null,
    };
    const { dom, w, action } = await boot(undefined, undefined, undefined, {}, undefined, {}, { board });
    try {
      w.eval(
        "window.execDetailBase=VM.execDetail;VM.execDetail=function(){return {id:'job-owner',threadId:'thread-owner',state:'failed',failed:true,trace:[]}};",
      );
      const recovery = w.document.createElement('div');
      w.document.body.append(recovery);
      recovery.innerHTML = w.eval("pdlView('ws.execDetail')");
      expect(declaredMenu(w, 'opForceReset')[0]).toMatchObject({
        act: 'opForceReset',
        danger: true,
        data: { threadId: 'thread-owner' },
      });
      action.mockClear();
      w.eval("A.opForceReset({threadId:'thread-owner'})");
      expect(action).not.toHaveBeenCalled();
      action.mockResolvedValueOnce(false);
      await w.eval('dialogSubmit(S.dialog)');
      expect(action).toHaveBeenCalledWith('opForceReset', { threadId: 'thread-owner' }, undefined);
      expect(w.eval('S.dialog')).not.toBeNull();
      action.mockResolvedValueOnce(true);
      await w.eval('dialogSubmit(S.dialog)');
      expect(w.eval('S.dialog')).toBeNull();
      w.eval(
        "window.boardBase=VM.hubPanel;VM.hubPanel=function(){return {ext:{cur:'reflux',hasRows:true,rows:[{id:'lesson-owner',projectId:'project-owner',canDeleteReflux:true,title:'Owner lesson'}]}}};S.ws.hubView='ext';",
      );
      recovery.innerHTML = w.eval("pdlView('ws.board')");
      const item = declaredMenu(w, 'wsRefluxDelete')[0];
      expect(item).toMatchObject({
        act: 'wsRefluxDelete',
        danger: true,
        data: { projectId: 'project-owner', id: 'lesson-owner' },
      });
      await w.eval(`A.wsRefluxDelete(${JSON.stringify(item.data)})`);
      expect(action).toHaveBeenCalledWith('wsRefluxDelete', item.data, undefined);
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('projects playback changes from held data without a host UI effect or model pull', async () => {
    const { dom, w, port, buildModels } = await boot();
    try {
      port.data.playback = { state: 'playing', messageId: 'reply-1' };
      w.clowderChat.update(port);
      await w.__settled();
      buildModels.mockClear();
      expect(w.eval('VM.chatStream().items[1].actsCtx.speaking')).toBe(true);
      expect(buildModels).not.toHaveBeenCalled();
      w.eval('window.ownerRenders=0;onRender(function(){window.ownerRenders++;});');
      // The host retains the playback reference until its state changes.
      w.clowderChat.update(port);
      expect(w.ownerRenders).toBe(0);
      expect(buildModels).not.toHaveBeenCalled();
      port.data.playback = { state: 'idle', messageId: null };
      w.clowderChat.update(port);
      buildModels.mockClear();
      expect(w.eval('VM.chatStream().items[1].actsCtx.speaking')).toBe(false);
      expect(buildModels).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('holds each project binding independently and skips an identical aggregate push', async () => {
    const { dom, w, port, buildModels } = await boot();
    try {
      port.data.project = {
        first: { revision: 1, items: [{ id: 'one', text: 'First' }] },
        second: { revision: 1, items: [{ id: 'two', text: 'Second' }] },
      };
      w.clowderChat.update(port);
      await w.__settled();
      w.eval(
        'window.drawn=0; var cl=ctLeaf; ctLeaf=function(k,g,d){var was=CT_PIECE[k],r=cl(k,g,d); if(CT_PIECE[k]!==was) window.drew=true; return r;}; var rr=render; render=function(k){window.drew=false; var r=rr(k); if(window.drew) window.drawn++; return r;}; window.heldSecond=chatDataSnapshot.project.second;',
      );
      buildModels.mockClear();
      port.data.project = { ...(port.data.project as object) };
      w.clowderChat.update(port);
      expect(w.eval('drawn')).toBe(0);
      expect(buildModels).not.toHaveBeenCalled();
      port.data.project = {
        first: { revision: 2, items: [{ id: 'one', text: 'Changed' }] },
        second: w.eval('window.heldSecond'),
      };
      w.clowderChat.update(port);
      expect(w.eval('projectDataDiff')).toEqual({ added: [], changed: ['first'], removed: [] });
      expect(w.eval('chatDataSnapshot.project.second===window.heldSecond')).toBe(true);
      await w.__settled();
      expect(w.eval('drawn')).toBe(0); // no view reads these owners: the changed one is held without a render pass
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('opens the r141 workspace locator from the existing media dialog', async () => {
    const reviews = contentRuntimeReviews();
    const work = reviews.openedWork.artifact;
    const source = {
      ...reviews,
      openedWork: {
        artifact: {
          ...work,
          sourceFacts: {
            ...work.sourceFacts,
            fileSource: { kind: 'workspace', worktreeId: 'wt', path: 'art/owner.png' },
          },
        },
      },
    };
    const { dom, w, action } = await boot(
      undefined,
      (_data, ui) => {
        ui.lb = { mid: '', block: '', i: 0 };
      },
      undefined,
      {},
      undefined,
      {},
      { reviews: source },
    );
    try {
      expect(w.eval('VM.mediaPreview().file')).toEqual({ worktreeId: 'wt', path: 'art/owner.png' });
      const button = w.document.querySelector('[data-pop="media"] [data-act="workOpenFile"]');
      expect(button).not.toBeNull();
      button.click();
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith('fileOpen', { w: 'wt', p: 'art/owner.png' }, undefined),
      );
      expect(w.eval('CS.lb')).toBeNull();
      expect(w.eval("rtTab('panel',rtCur('panel')).preview")).toBe(true);
      await w.eval("A.workOpenFile({path:'art/owner.png:3-9',worktreeId:'wt'})");
      expect(action).toHaveBeenLastCalledWith('fileOpen', { w: 'wt', p: 'art/owner.png' }, undefined);
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('dispatches the copied discovered-service row and story annotation input with r141 coordinates', async () => {
    const preview = {
      gateway: { load: '', port: 4111 },
      health: { key: '', reachable: false },
      pending: null,
      hmr: 'connected',
      receipt: null,
      console: [],
      warn: '',
      pendingAuto: null,
      target: null,
      src: '',
      ready: false,
      capturing: false,
      threadId: 'pdl-test',
      discovered: {
        worktreeId: 'wt',
        load: '',
        services: [{ port: 3013, framework: 'Vite', reachable: true, worktreeId: 'wt', discoveredAt: 1 }],
      },
    };
    const replay = {
      thread: 'pdl-test',
      source: 'F900',
      storyId: 'feat:F900',
      load: '',
      typingMs: null,
      engine: {
        state: 'paused',
        currentIndex: 0,
        speed: 10,
        adaptivePacing: true,
        displayMode: 'cinematic',
        elapsedMs: 0,
        totalDurationMs: 0,
      },
      events: [{ eventNo: 0, type: 'message', role: 'user', content: 'Story event', timestamp: 1000 }],
      eventTimes: [7000],
      messages: [],
      chapters: [],
      features: [{ id: 'feature', featureId: 'F900', title: 'Owner feature' }],
      guideScript: [],
      guideHtml: '',
      guideLanguage: 'zh',
      guideTeam: {},
      annotations: {
        storyId: 'feat:F900',
        load: '',
        error: '',
        value: { storyId: 'feat:F900', version: 1, annotations: [] },
      },
    };
    const { dom, w, action } = await boot(
      undefined,
      undefined,
      undefined,
      { previewState: { tabs: [], active: '', consoleOpen: false, filter: 'all' } },
      undefined,
      {},
      { preview, replay },
    );
    try {
      w.eval("ENGINE_PARTS.openTab('panel','preview')");
      await w.__settled();
      w.document.querySelector('[data-act="pvDiscovered"][data-port="3013"]').click();
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith('pvDiscovered', expect.objectContaining({ port: 3013 }), undefined),
      );
      await w.eval("A.theater({ id:'pdl-test',storyId:'feat:F900'})");
      expect(action).toHaveBeenCalledWith('replayOpen', { id: 'pdl-test', storyId: 'feat:F900' }, undefined);
      const input = w.document.getElementById('story-annotation');
      expect(input).not.toBeNull();
      input.closest('[data-add-field]').querySelector('[data-act="fieldAddToggle"]').click();
      input.value = 'Owner narration';
      const submit = input.closest('.ifield').querySelector('[data-act="fieldGo"]');
      expect(submit).not.toBeNull();
      submit.click();
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith(
          'rpAnnotate',
          expect.objectContaining({ storyId: 'feat:F900', at: 7000, v: 'Owner narration' }),
          undefined,
        ),
      );
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('registers the cafe navigation family with original arguments and uses held execution identities', async () => {
    const { dom, w, data, port, action, errors } = await boot(undefined, (data) => {
      data.messages[1].extra = { stream: { turnInvocationId: 'exact-turn' } };
    });
    try {
      w.eval(
        'window.destinations=[]; go=function(to,opts){ window.destinations.push([to,opts]); }; window.opened=[]; ENGINE_PARTS.openTab=function(region,key){window.opened.push([region,key]);}; delete A.runOpen; A.runOpen=function(d){window.runArgs=d;};',
      );
      w.eval("A.memberOpen({p:'codex'}); A.pluginOpen({to:'plugin.owner'});");
      expect(w.destinations).toEqual([
        ['member-codex', { ask: true }],
        ['plugin.owner', { ask: true }],
      ]);
      await w.eval('A.cbAuthOpen()');
      expect(w.eval('S.ws.opsView')).toBe('obs');
      expect(w.eval('S.ws.obsV')).toBe('auth');
      expect(action).toHaveBeenCalledWith('opsBrowse', {}, undefined);
      w.eval('A.traceOpen({i:1})');
      expect(w.runArgs).toEqual({ k: 'exact-turn' });
      data.messages[1].extra = {};
      port.data = fixtureInput(data);
      w.clowderChat.update(port);
      w.eval('A.traceOpen({i:1})');
      expect(w.opened.at(-1)).toEqual(['panel', 'exec']);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('opens and filters real input history, inserts a selected entry, and returns within a composer popup', async () => {
    const { dom, w, action, ui, errors } = await boot(undefined, (data) => {
      data.historyEntries = ['Owner draft', 'Another input'];
    });
    try {
      w.eval('A.histOpen()');
      expect(w.document.body.textContent).toContain('Owner draft');
      const q = w.document.getElementById('hs-q');
      q.value = 'owner';
      q.dispatchEvent(new w.Event('input', { bubbles: true }));
      expect(w.eval('VM.chatModal().data.items')).toEqual([{ t: 'Owner draft' }]);
      await w.eval("A.histPick({v:'Owner draft'})");
      expect(ui.modal).toBeNull();
      expect(action).toHaveBeenCalledWith('compose', expect.objectContaining({ v: 'Owner draft' }));
      ui.pop = { kind: 'target', page: 'second', stack: ['main'] } as typeof ui.pop;
      w.eval('A.popBack()');
      expect(ui.pop?.page).toBe('main');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('uses the find result list for next/previous and restores the original scroll position', async () => {
    const { dom, w, action, errors } = await boot(undefined, (data, ui) => {
      data.messages[1].content = '检查第二条';
      ui.find.q = '检查';
    });
    try {
      w.document.getElementById('stream').scrollTop = 160;
      await w.eval('A.findOpen({i:0})');
      expect(action).toHaveBeenLastCalledWith('jump', { mid: 'reply-1', thread: 'pdl-test' }, undefined);
      await w.eval('A.findStep({v:1})');
      expect(action).toHaveBeenLastCalledWith('jump', { mid: 'user-1', thread: 'pdl-test' }, undefined);
      await w.eval('A.findStep({v:-1})');
      expect(action).toHaveBeenLastCalledWith('jump', { mid: 'reply-1', thread: 'pdl-test' }, undefined);
      expect(w.eval('VM.chatPage().find.index')).toBe(1);
      w.eval('A.findBack()');
      expect(w.eval('CS.findNav')).toBeNull();
      expect(w.document.getElementById('stream').scrollTop).toBe(160);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('sidebar search finds threads in its popup and presets organize with the matches', async () => {
    const { dom, w, errors } = await boot(
      undefined,
      (data) => {
        data.threads[0].title = 'Needle conversation';
      },
      undefined,
      { sidebarOwner: { preferences: { groups: [] }, labels: [] } },
    );
    try {
      const listed = () =>
        w.eval('VM.navThreads().sections.flatMap(function (s) { return s.rows.map(function (r) { return r.id; }); })');
      const before = listed();
      w.eval('A.searchOpen()');
      expect(w.eval('CS.navFind && VM.cafeNavShell().findOpen')).toBe(true);
      w.eval("CS.navQ='needle'");
      expect(w.eval('VM.navFind().items.map(function (t) { return t.id; })')).toEqual(['pdl-test']);
      expect(w.eval('VM.navFind().matches')).toBe(1);
      expect(listed()).toEqual(before);
      await w.eval('A.cafeSearchOrg()');
      expect(w.eval('CS.modal.sel')).toEqual({ 'pdl-test': true });
      w.eval('A.searchOpen()');
      expect(w.eval('CS.navFind')).toBe(false);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('submits the selected inbox decisions through their existing native writer without local history mutations', async () => {
    const { dom, w, action, errors } = await boot();
    try {
      action.mockClear();
      w.eval('CS.ib.apPick={one:true,two:true};');
      await w.eval("A.cafeIbBatch({res:'accept'})");
      expect(action.mock.calls).toEqual([
        ['cardDecide', { mid: 'one', v: 'ok' }],
        ['cardDecide', { mid: 'two', v: 'ok' }],
      ]);
      expect(w.eval('CS.ib.apPick')).toEqual({});
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('registers memory save handlers and waits for the real person forget confirmation', async () => {
    const { dom, w, action, errors } = await boot();
    try {
      for (const name of ['memoryRecordSave', 'personClaimSave', 'personEventSave', 'profileSave']) {
        w.testMemoryName = name;
        await w.eval("A[window.testMemoryName]({id:'owner',expectedRevision:'r0',payload:{statement:'Kept'}})");
        expect(action).toHaveBeenLastCalledWith(name, {
          id: 'owner',
          expectedRevision: 'r0',
          payload: { statement: 'Kept' },
        });
      }
      action.mockRejectedValueOnce(new Error('Revision changed'));
      w.eval(
        "dialog({title:'Owner write',ok:'Save',on:function(){return A.profileSave({id:'owner',kind:'profile',expectedRevision:'r0',content:'Edited'});}})",
      );
      await w.eval('dialogSubmit()');
      expect(w.eval('S.dialog.error')).toBe('Revision changed');
      await w.eval('dialogSubmit()');
      expect(w.eval('S.dialog')).toBeNull();
      action.mockClear();
      w.eval("A.personForget({personId:'person',expectedPersonRevision:'person-r0'})");
      expect(action).not.toHaveBeenCalled();
      await w.eval('dialogSubmit()');
      expect(action).not.toHaveBeenCalled();
      w.document.getElementById('dlg-ck').checked = true;
      await w.eval('dialogSubmit()');
      expect(action).toHaveBeenCalledWith('personForget', {
        personId: 'person',
        expectedPersonRevision: 'person-r0',
        confirmed: true,
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('uses inbox producer coordinates for selected approvals that are outside the current message stream', async () => {
    const { dom, w, action, errors } = await boot(undefined, undefined, undefined, {}, (port) => {
      const previous = vi.mocked(port.get).getMockImplementation()!;
      vi.mocked(port.get).mockImplementation(async (path, params) =>
        path === '/api/concierge/work/decisions'
          ? {
              status: 'available',
              identity: { ownerUserId: 'owner' },
              attentionCount: 1,
              items: [
                {
                  decisionRef: 'approval:remote',
                  summary: 'Remote approval',
                  approval: {
                    proposalId: 'remote',
                    sourceFeatureId: 'F193',
                    resolution: 'open',
                    inlineApprovable: true,
                    detail: {},
                    navigation: {
                      state: 'anchored',
                      approvalCardRef: { threadId: 'remote-thread', messageId: 'remote-card' },
                    },
                  },
                },
              ],
              page: { offset: 0, limit: 20, hasMore: false },
            }
          : previous(path, params),
      );
    });
    try {
      action.mockClear();
      w.eval("CS.ib.apPick={'remote-card':true}; CS.ib.view='approvals'");
      expect(w.eval('VM.cafeInbox().ap.pendingItems[0].ctx.canDecide')).toBe(true);
      await w.eval("A.cafeIbBatch({res:'reject'})");
      expect(action).toHaveBeenCalledWith('inboxDecide', { id: 'remote', owner: 'owner', res: 'reject' }, undefined);
      expect(w.eval('CS.ib.apPick')).toEqual({});
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('saves and resets thread tags using real label ids, and reveals the current attention group', async () => {
    const { dom, w, action, ui, errors } = await boot(
      undefined,
      (data) => {
        data.threads[0].labels = ['old'];
      },
      undefined,
      {
        sidebarOwner: {
          preferences: {
            groups: [{ id: 'attention_owner', name: 'Owner', threadIds: ['pdl-test'] }],
            open: { 'group:attention_owner': false },
          },
          labels: [
            { id: 'old', name: 'Old', color: '#527b99' },
            { id: 'next', name: 'Next', color: '#527b99' },
          ],
        },
        memberSettings: { cats: [] },
      },
      (port) => {
        const previous = vi.mocked(port.get).getMockImplementation()!;
        vi.mocked(port.get).mockImplementation(async (path, params) =>
          path.endsWith('/goal')
            ? { goal: null, nativeTargets: [] }
            : path.endsWith('/native-status')
              ? { statuses: [] }
              : /\/members\/(effort|speed)$/.test(path)
                ? { members: [] }
                : previous(path, params),
        );
      },
    );
    try {
      await w.eval("A.threadSettings({id:'pdl-test',v2:'tags'})");
      expect(w.eval('VM.chatModal().data.tags').map((x: { id: string; on: boolean }) => [x.id, x.on])).toEqual([
        ['old', true],
        ['next', false],
      ]);
      w.eval('CS.modal.sel={next:true}');
      await w.eval("A.cafeTsTags({v:'save'})");
      expect(action).toHaveBeenCalledWith('sidebarLabels', { id: 'pdl-test', value: '["next"]' }, undefined);
      w.eval("A.cafeTsTags({v:'reset'})");
      expect(w.eval('CS.modal.sel')).toEqual({ old: true });
      ui.modal = null;
      w.eval("CS.lastGid='attention_owner';A.cafeOrgView()");
      expect(w.document.querySelector('[data-gid="attention_owner"]').hasAttribute('data-collapsed')).toBe(false);
      ui.group = 'favorites';
      ui.tag = 'invisible';
      w.eval('A.locate()');
      expect(ui.group).toBe('recent');
      expect(ui.tag).toBeNull();
      expect(w.document.querySelector('[data-tid="pdl-test"]').classList.contains('emph-ring')).toBe(true);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('keeps backend-default attention groups visible when a conversation opens with a fresh host state', async () => {
    const owner = {
      preferences: {
        groups: [
          { id: 'attention_default', threadIds: ['pdl-test'] },
          { id: 'attention_closed', threadIds: ['closed-thread'] },
        ],
        aliases: {},
        open: { 'group:attention_closed': false },
      },
      labels: [],
    };
    const { dom, w, port, data, ui, errors, buildModels } = await boot(
      undefined,
      (data) => {
        data.threads.push({ ...data.threads[0], id: 'closed-thread', title: 'Explicitly closed' });
      },
      undefined,
      { sidebarOwner: owner },
    );
    try {
      expect(w.eval('VM.navThreads().sections.find(g=>g.gid==="attention_default").head.open')).toBe(true);
      expect(w.eval('VM.navThreads().sections.find(g=>g.gid==="attention_closed").collapsed')).toBe(true);
      data.threadId = 'closed-thread';
      port.threadId = data.threadId;
      port.state = { ...fixtureUi(), workspace: ui.workspace };
      port.data = { ...port.data, chat: fixtureInput(data).chat };
      port.sidebarData = fixtureSidebar(data, { owner });
      w.clowderChat.update(port);
      await w.__settled();
      expect(w.eval('VM.navThreads().sections.find(g=>g.gid==="attention_default").head.open')).toBe(true);
      expect(w.eval('VM.navThreads().sections.find(g=>g.gid==="attention_closed").collapsed')).toBe(true);
      expect(w.document.querySelectorAll('.cafe-trow[data-tid]').length).toBeGreaterThan(0);
      expect(errors).not.toHaveBeenCalled();
      expect(buildModels).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('projects missing attention preferences and expands pinned/recent more controls without a data pull', async () => {
    const { dom, w, buildModels, errors } = await boot(
      undefined,
      (data) => {
        data.threads.push(
          ...Array.from({ length: 32 }, (_, i) => ({
            ...data.threads[0],
            id: 'many-' + i,
            pinned: i < 16,
            title: 'Thread ' + i,
          })),
        );
      },
      undefined,
      { sidebarOwner: { preferences: { groups: [{ id: 'attention_owner', threadIds: ['pdl-test'] }] }, labels: [] } },
    );
    try {
      expect(w.document.querySelector('[data-gid="attention_owner"]')).not.toBeNull();
      buildModels.mockClear();
      for (const key of ['pinned', 'recent']) {
        const section = w.document.querySelector(`[data-sec="${key}"]`);
        section.querySelector('[data-f="more"]').click();
        expect(section.hasAttribute('data-more')).toBe(true);
      }
      expect(buildModels).not.toHaveBeenCalled();
      w.eval('render(true)');
      for (const key of ['pinned', 'recent'])
        expect(w.document.querySelector(`[data-sec="${key}"]`).hasAttribute('data-more')).toBe(true);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('renders and projects 500 held VM reads without calling the host model builder', async () => {
    const groupedIds = Array.from({ length: 200 }, (_, i) => 'bulk-' + i);
    const { dom, w, data, port, buildModels, errors } = await boot(undefined, undefined, undefined, {
      sidebarOwner: {
        preferences: { groups: [{ id: 'group', name: 'Group', threadIds: groupedIds }], open: {} },
        runningThreadIds: [],
        labels: [],
        unread: 0,
      },
    });
    try {
      for (let i = 0; i < 500; i++)
        w.eval('VM.navThreads();VM.chatHeader();VM.chatComposer();VM.chatStream();VM.memberCard();');
      w.eval('render(true)');
      expect(buildModels).not.toHaveBeenCalled();
      data.threads = data.threads.map((row, i) => (i ? row : { ...row, title: 'Changed after commit' }));
      buildModels.mockClear();
      const diff = w.clowderChat.pushSidebar({ ...port.sidebarData, threads: fixtureSidebar(data).threads });
      expect(diff).toEqual({ added: [], changed: ['pdl-test'], removed: [], orderChanged: false, fields: [] });
      expect(buildModels).not.toHaveBeenCalled();
      await w.__settled();
      expect(w.document.body.textContent).toContain('Changed after commit');
      data.threads = Array.from({ length: 500 }, (_, i) => ({
        ...data.threads[0],
        id: 'bulk-' + i,
        title: 'Synthetic thread ' + i,
        lastActiveAt: i,
        pinned: i % 5 === 0,
      }));
      w.sidebarInput = { ...port.sidebarData, threads: data.threads };
      w.eval('receiveSidebar(window.sidebarInput)');
      const nav = w.eval('VM.navThreads()');
      expect(nav.sections.find((s: { key: string }) => s.key === 'grp:group').rows).toHaveLength(200);
      expect(nav.sections.find((s: { key: string }) => s.key === 'pinned').rows).toHaveLength(60);
      expect(nav.sections.find((s: { key: string }) => s.key === 'recent').rows).toHaveLength(240);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('holds sidebar data across reads and does not render an unchanged push', async () => {
    const { dom, w, port, buildModels, errors } = await boot();
    try {
      w.eval('window.sidebarRenders = 0; onRender(function () { window.sidebarRenders++; });');
      buildModels.mockClear();
      const diff = w.clowderChat.pushSidebar(port.sidebarData);
      expect(diff).toEqual({ added: [], changed: [], removed: [], orderChanged: false, fields: [] });
      expect(w.sidebarRenders).toBe(0);
      for (let i = 0; i < 500; i++) w.eval('VM.navThreads(); ENT.thread.coll()');
      expect(buildModels).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('does not render or pull models when the same immutable sources are pushed', async () => {
    const { dom, w, port, ui, buildModels, errors } = await boot();
    try {
      port.data.project = { native: { reviews: [], load: '' }, sessions: [], error: new Error('Owner offline') };
      w.clowderChat.update(port);
      await w.__settled();
      w.eval('window.dataRenders = 0; onRender(function () { window.dataRenders++; });');
      buildModels.mockClear();
      // A local selection is not incoming owner data and must not enter the data comparison.
      ui.group = 'project';
      for (let i = 0; i < 30; i++) w.clowderChat.update(port);
      expect(w.dataRenders).toBe(0);
      expect(buildModels).not.toHaveBeenCalled();
      port.data.project = { native: { reviews: [], load: '' }, sessions: [{ id: 'new-session' }], error: null };
      w.clowderChat.update(port);
      await w.__settled();
      expect(w.dataRenders).toBe(1);
      expect(w.eval('chatDataSnapshot.project.sessions')).toEqual([{ id: 'new-session' }]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('reports only the changed thread and keeps other held records when receiving a data snapshot', async () => {
    const { dom, w, data, port, errors } = await boot(undefined, (data) => {
      data.threads.push({ ...data.threads[0], id: 'other', title: 'Unchanged thread' });
    });
    try {
      w.eval('window.unchangedThread = sidebarData().threads[1]');
      data.threads = data.threads.map((row, i) => (i ? row : { ...row, title: 'New thread data' }));
      const incoming = {
        ...port.sidebarData,
        threads: port.sidebarData.threads.map((row, i) => (i ? row : { ...row, title: 'New thread data' })),
      };
      expect(w.eval('VM.navThreads().sections[0].rows[0].title')).toBe('对话绑定验收');
      const diff = w.clowderChat.pushSidebar(incoming);
      expect(diff).toEqual({ added: [], changed: ['pdl-test'], removed: [], orderChanged: false, fields: [] });
      expect(w.eval('sidebarData().threads[1] === window.unchangedThread')).toBe(true);
      expect(w.eval('VM.navThreads().sections[0].rows[0].title')).toBe('New thread data');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('awaits a plugin row operation under its original confirmation and keeps an owner refusal in the dialog', async () => {
    let acknowledge!: (value: unknown) => void;
    const { dom, w, action, errors } = await boot();
    action.mockImplementation(
      async () =>
        new Promise<unknown>((resolve) => {
          acknowledge = resolve;
        }),
    );
    action.mockClear();
    try {
      w.eval(
        "pcfModel('owner-ops', {plugin:'dev.owner.operations',installed:true,fields:[{key:'sessions',kind:'operation',label:'Sessions',actions:[{id:'list',label:'Read sessions',render:'button',resultRender:'rows',confirm:'Read owner sessions?'}],rowActions:[{id:'remove',label:'Remove',next:'list'}]}]})",
      );
      w.eval(
        "pcfState('owner-ops').ops.sessions.rows={rows:[{key:'owner:key',label:'Actual owner row',actions:[{action:'remove',label:'Remove this row',confirm:'Remove this owner row?',input:{sessionId:'real-session'}}]}]}",
      );
      w.eval("A.pcfOp({p:'owner-ops',f:'sessions',r:'owner:key',a:'remove'})");
      expect(action).not.toHaveBeenCalled();
      const submission = w.eval('dialogSubmit()');
      await Promise.resolve();
      expect(w.eval('S.dialog')).toBeNull(); // closed while its owner works; the trigger shows progress
      expect(action).toHaveBeenLastCalledWith('pluginOperation', {
        id: 'dev.owner.operations',
        operation: 'sessions',
        action: 'remove',
        value: '{"rowKey":"owner:key","input":{"sessionId":"real-session"}}',
        confirmed: 'true',
      });
      acknowledge({ ok: false, label: 'owner refused removal' });
      await submission;
      await w.__settled();
      expect(w.document.querySelector('.dialog')?.textContent).toContain('owner refused removal');
      expect(w.eval("pcfState('owner-ops').ops.sessions.rows.rows.length")).toBe(1);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('renders a member configuration field as a choice among the Host members', async () => {
    const { dom, w, errors } = await boot();
    try {
      const row = w.eval(
        "WHO_DATA.members=function(){return [{id:'opus',name:'Opus'},{id:'codex',name:'Codex'}]};pcfModel('member-pick',{plugin:'official.companion',installed:true,fields:[{key:'dutyCatProfileId',kind:'member',label:'Member',required:false,currentValue:'codex'}]}).rows[0]",
      );
      expect(row.kind).toBe('select');
      expect(row.value).toBe('codex');
      expect(row.options).toEqual([
        { value: 'opus', label: 'Opus' },
        { value: 'codex', label: 'Codex' },
      ]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('renders real plugin schema branches and retains a rejected config draft until its owner accepts', async () => {
    const variants = {
      discriminator: 'mode',
      branches: [
        { id: 'token', when: { properties: { mode: { const: 'token' } } }, fields: ['token'] },
        { id: 'url', when: { properties: { mode: { const: 'url' } } }, fields: ['url'] },
      ],
    };
    const plugin = {
      pluginId: 'dev.owner.config',
      displayName: 'Owner config',
      artifact: 'installed',
      intent: 'enabled',
      lifecycleRevision: 3,
      source: { kind: 'local-archive' },
      actions: { setEnabled: true, uninstall: true },
      contributions: [],
      configFields: [
        {
          key: 'mode',
          label: 'Mode',
          kind: 'select',
          required: true,
          currentValue: 'token',
          options: [
            { value: 'token', label: 'Token' },
            { value: 'url', label: 'URL' },
          ],
          configurationVariants: variants,
        },
        {
          key: 'token',
          label: 'Secret',
          kind: 'secret',
          required: true,
          currentValue: '••••••',
          configurationVariants: variants,
        },
        {
          key: 'url',
          label: 'Endpoint',
          kind: 'url',
          required: true,
          currentValue: null,
          configurationVariants: variants,
        },
      ],
    };
    let fail = true;
    const writes: unknown[] = [];
    const { dom, w, errors } = await boot(undefined, undefined, undefined, {}, (port) => {
      const original = port.get;
      port.get = async (path) =>
        path === '/api/plugin-manager/plugins'
          ? { plugins: [structuredClone(plugin)] }
          : path === '/api/plugin-manager/plugins/' + plugin.pluginId
            ? { plugin: structuredClone(plugin) }
            : original(path);
      port.post = async (path, _params, body) => {
        writes.push({ path, body });
        if (fail) throw new Error('owner config rejected');
        plugin.lifecycleRevision++;
        return { ok: true };
      };
    });
    try {
      w.eval("go('extItem', 'dev.owner.config')");
      await w.__settled();
      expect(w.document.getElementById('pcf-dev-owner-config-token')?.getAttribute('placeholder')).toContain('已设置');
      expect(w.document.getElementById('pcf-dev-owner-config-url')).toBeNull();
      const mode = w.document.getElementById('pcf-dev-owner-config-mode');
      mode.value = 'url';
      mode.dispatchEvent(new w.Event('change', { bubbles: true }));
      await w.__settled();
      const endpoint = w.document.getElementById('pcf-dev-owner-config-url');
      endpoint.value = 'https://endpoint.test/';
      endpoint.dispatchEvent(new w.Event('input', { bubbles: true }));
      await w.__settled();
      const submit = () => w.eval("FORMS.pcf(document.querySelector('form[data-form=pcf]'))");
      await submit();
      await w.__settled();
      expect(w.eval("pcfState('dev.owner.config').draft.url")).toBe('https://endpoint.test/');
      expect(writes[0]).toEqual({
        path: '/api/plugin-manager/plugins/dev.owner.config/contributions/configuration',
        body: {
          expectedRevision: 3,
          updates: [
            { key: 'mode', value: 'url' },
            { key: 'url', value: 'https://endpoint.test/' },
          ],
        },
      });
      fail = false;
      await submit();
      await w.__settled();
      expect(w.eval("pcfDirty('dev.owner.config')")).toBe(false);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('keeps general UI choices local and sends the busy policy to its real owner', async () => {
    const { dom, w, action, ui, errors } = await boot(
      undefined,
      (data) => {
        data.messages[1].thinking = 'owner thinking';
      },
      undefined,
      { systemGeneral: { load: '', send: 'next' } },
    );
    try {
      w.eval("go('system')");
      await w.__settled();
      const record = w.document.getElementById('sys-record');
      record.value = 'expanded';
      record.dispatchEvent(new w.Event('change', { bubbles: true }));
      await w.__settled();
      expect(ui.recordExpanded).toBe(true);
      expect(JSON.parse(w.localStorage.getItem('clowder-proto3:sys'))).toEqual({ record: 'expanded' });
      const busy = w.document.getElementById('sys-send');
      busy.value = 'current';
      busy.dispatchEvent(new w.Event('change', { bubbles: true }));
      await w.__settled();
      expect(action).toHaveBeenLastCalledWith('systemSend', { v: 'current' }, undefined);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('opens the message selection toolbar and forwards its exact quote through the existing dialog', async () => {
    const { dom, w, ui, action, errors } = await boot();
    try {
      const quote = {
        kind: 'quote' as const,
        messageId: 'reply-1',
        text: 'selected owner text',
        renderedOccurrences: 1,
        selectionStart: 3,
        selectionEnd: 22,
      };
      ui.pop = { kind: 'textsel', mid: 'reply-1', text: quote.text, selection: quote };
      w.clowderChat.update();
      await w.__settled();
      expect(w.document.querySelector('[data-pop="chat.pop"] [data-v="quote"]')).not.toBeNull();
      const forward = w.document.querySelector('[data-pop="chat.pop"] [data-v="fwd"]');
      expect(forward).not.toBeNull();
      forward.click();
      await w.__settled();
      expect(ui.modal).toMatchObject({ kind: 'forward', messageIds: ['reply-1'], selectionItems: [quote] });
      ui.modal!.to = 'other';
      ui.modal!.cats = ['codex'];
      await w.eval('FORMS.cafeModal()');
      await w.__settled();
      expect(action).toHaveBeenLastCalledWith('forward', {
        to: 'other',
        cats: '["codex"]',
        mids: '["reply-1"]',
        partial: 'false',
      });
      expect(ui.modal).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it.each(['correct', 'transfer'])('submits every entity replacement from the declared %s inputs', async (op) => {
    const { dom, w, action, errors } = await boot(undefined, (data) => {
      const block = { v: 1 as const, kind: 'card' as const, id: 'conflict', title: 'Entity conflict' };
      const item: ApprovalHubItem = {
        proposalId: 'entity-1',
        sourceFeatureId: 'F260',
        ownerUserId: 'owner',
        requesterCatId: 'codex',
        summary: 'Entity conflict',
        resolution: 'open',
        inlineApprovable: true,
        navigation: {
          state: 'anchored',
          originRef: { kind: 'message', threadId: data.threadId, messageId: 'user-1' },
          approvalCardRef: { threadId: data.threadId, messageId: 'reply-1' },
        },
        detail: {
          conflict: {
            fingerprint: 'b'.repeat(64),
            incoming: { canonicalName: 'New' },
            candidates: ['first', 'second'].map((key) => ({
              entityId: 'concept:' + key,
              canonicalName: key,
              aliases: [],
              stance: 'endorsed',
            })),
            canonicalReplacementRequiredFor: ['concept:first', 'concept:second'],
            allowedActions: ['correct', 'transfer', 'reject'],
          },
        },
        materialization: { state: 'not_started' },
        createdAt: 1,
      };
      data.memoryProposals = {
        'entity-1': {
          target: { id: 'entity-1', feature: 'F260', threadId: data.threadId, mid: 'reply-1', block },
          read: {
            item,
            status: 'pending',
            effect: false,
            evidence: {
              decisionRef: 'entity-decision',
              kind: 'approval',
              summary: item.summary,
              approval: item,
              linkedNeedsMe: [],
            },
          },
          current: true,
          refresh: vi.fn(),
        },
      };
    });
    try {
      w.document.querySelector(`[data-act="entityAction"][data-v="${op}"]`).click();
      await w.__settled();
      for (const key of ['first', 'second']) {
        const input = w.document.getElementById('entity-name-reply-1-concept:' + key);
        expect(input).not.toBeNull();
        input.value = 'Renamed ' + key;
        input.dispatchEvent(new w.Event('input', { bubbles: true }));
      }
      expect(action.mock.calls.filter(([name]) => name === 'entityResolve')).toHaveLength(0);
      w.document.querySelector('[data-go="entityName"] [data-act="fieldGo"]').click();
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith(
          'entityResolve',
          {
            mid: 'reply-1',
            fingerprint: 'b'.repeat(64),
            action: op,
            replacementCanonicalNames: JSON.stringify({
              'concept:first': 'Renamed first',
              'concept:second': 'Renamed second',
            }),
          },
          undefined,
        ),
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it.each(['work', 'cli'] as const)('keeps %s selections quotable without offering forward', async (kind) => {
    const { dom, w, ui, action, errors } = await boot();
    try {
      if (kind === 'cli')
        ui.pop = {
          kind: 'textsel',
          mid: 'reply-1',
          text: 'Selected tool output',
          source: {
            kind: 'cli_output',
            threadId: 'pdl-test',
            messageId: 'reply-1',
            toolUseId: 'native',
            executionRef: 'turn',
            part: 'result',
          },
          selectionStart: 0,
          selectionEnd: 20,
        };
      else w.eval("CS.pop={kind:'textsel',work:'owner-work',text:'Selected work body'}");
      w.clowderChat.update();
      await w.__settled();
      const pop = w.document.querySelector('[data-pop="chat.pop"]');
      expect(pop.querySelector('[data-v="fwd"]')).toBeNull();
      const quote = pop.querySelector('[data-v="ctx"]');
      expect(quote).not.toBeNull();
      quote.click();
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith(
          kind === 'cli' ? 'cliQuote' : 'workFileQuote',
          kind === 'cli' ? {} : { quote: 'Selected work body' },
          undefined,
        ),
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('opens real member candidates at the caret and chooses one without sending or losing the input suffix', async () => {
    const { dom, w, data, ui, action, errors } = await boot();
    action.mockImplementation(async (name, args) => {
      if (name === 'compose') {
        data.input = args.v;
        ui.pop = composerTrigger(args.v, Number(args.pos));
      }
    });
    try {
      const input = w.document.getElementById('chat-input');
      input.focus();
      input.value = 'before @co tail';
      input.setSelectionRange(10, 10);
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await w.__settled();
      expect(w.document.querySelector('[data-pop="chat.pop"]')?.textContent).toContain('Codex');
      w.document
        .getElementById('chat-input')
        .dispatchEvent(new w.KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      await w.__settled();
      expect(data.input).toBe('before @codex  tail');
      expect(action.mock.calls.some(([name]) => name === 'send')).toBe(false);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('anchors mention candidates before drawing them and shows the member catalog and breed groups without a single-character history ghost', async () => {
    const { dom, w, data, ui, push, action, port, errors } = await boot(undefined, (data) => {
      const member = data.cats[0];
      data.cats = ['codex', 'sonnet', 'opus', 'siamese'].map((id, i) => ({
        ...member,
        id,
        displayName: ['Codex', 'Sonnet', 'Opus', 'Siamese'][i],
        mentionPatterns: ['@' + id],
        breedId: i < 3 ? 'maine-coon' : 'siamese',
        breedDisplayName: i < 3 ? '缅因猫' : '暹罗猫',
        defaultModel: ['GPT', 'Sonnet model', 'Opus model', 'Gemini'][i],
        roster: { family: 'test', roles: [], lead: false, available: true, evaluation: '' },
      }));
      data.cats.push({
        ...data.cats[0],
        id: 'disabled',
        displayName: 'Disabled member',
        mentionPatterns: ['@disabled'],
        roster: { family: 'test', roles: [], lead: false, available: false, evaluation: '' },
      });
      data.historyEntries = ['@opencode-glm hi'];
    });
    action.mockImplementation(async (name, args) => {
      if (name === 'compose') {
        data.input = args.v;
        const pop = composerTrigger(args.v, Number(args.pos));
        if (pop || ui.pop?.typed) ui.pop = pop;
      }
    });
    try {
      let input = w.document.getElementById('chat-input');
      const stream = w.document.querySelector('[data-stream] > [data-mid="reply-1"]');
      // counts whole-page passes: a composer-only redraw (the local sub-view path) is not one
      w.eval(
        'window.mentionRenders=0; var r1=renderAll; window.renderAll=function(){window.mentionRenders++; return r1.apply(this, arguments);}',
      );
      input.focus();
      input.value = '@';
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await w.__settled();
      input = w.document.getElementById('chat-input');
      const host = w.document.querySelector('[data-pop="chat.pop"]'),
        popup = host.querySelector('.pop.up'),
        spot = w.document.querySelector('[data-spot="caret"]');
      expect(ui.pop).toMatchObject({ typed: true, input: 'chat-input', up: true, span: 5, i: 0 });
      expect(w.eval('VM.chatPop().pos')).toEqual({ up: true, span: 5, fit: false });
      expect(host.style.getPropertyValue('--u-anchor')).toBe(spot.getAttribute('data-aname'));
      expect(host.style.getPropertyValue('--u-anchor')).not.toBe('');
      expect(popup.style.getPropertyValue('--u-w')).toBe('var(--span-5)');
      expect(popup.textContent).toContain('召唤猫猫');
      expect(popup.textContent).toContain('Codex @codex');
      expect(popup.textContent).toContain('缅因猫 · GPT');
      expect(popup.textContent).toContain('@全体缅因猫');
      expect(popup.textContent).toContain('3 只缅因猫');
      expect(popup.querySelectorAll('[data-act="cafeTypedPick"]')).toHaveLength(7);
      expect(popup.textContent).not.toContain('Disabled member');
      expect(w.eval('VM.chatComposer().input.value')).toBe('@');
      expect(w.document.querySelector('.composer').textContent).not.toContain('opencode-glm hi');
      const needed = new Set<string>();
      for (const [{ added, removed }] of port.needed.mock.calls) {
        removed.forEach((source: string) => needed.delete(source));
        added.forEach((source: string) => needed.add(source));
      }
      expect([...needed].some((source) => source.startsWith('chat.cats.'))).toBe(true);
      const renders = w.mentionRenders;
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await w.__settled();
      expect(w.mentionRenders).toBe(renders);
      input.value = '@o';
      input.setSelectionRange(2, 2);
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await w.__settled();
      expect(w.eval('VM.chatComposer().input.history[0]')).toBe('@opencode-glm hi');
      input = w.document.getElementById('chat-input');
      input.value = '@';
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await w.__settled();
      data.cats = [
        ...data.cats,
        { ...data.cats[3], id: 'new-member', displayName: 'New member', mentionPatterns: ['@new'] },
      ];
      push();
      await w.__settled();
      input = w.document.getElementById('chat-input');
      expect(w.eval('VM.chatPop().mentions').some((item: { name: string }) => item.name === 'New member')).toBe(true);
      expect(w.eval('WHO_DATA.members()').some((member: { id: string }) => member.id === 'new-member')).toBe(true);
      expect(w.document.querySelector('[data-stream] > [data-mid="reply-1"]')).toBe(stream);
      input.value = '@nothing-matches';
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await w.__settled();
      expect(w.document.querySelector('[data-pop="chat.pop"]').textContent).toContain('没有匹配的猫猫。');
      input = w.document.getElementById('chat-input');
      input.value = '';
      input.setSelectionRange(0, 0);
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await w.__settled();
      expect(w.document.querySelector('[data-pop="chat.pop"]')).toBeNull();
      input = w.document.getElementById('chat-input');
      const plainRenders = w.mentionRenders;
      for (const char of 'hello world') {
        input.value += char;
        input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new w.Event('input', { bubbles: true }));
        await w.__settled();
      }
      expect(w.mentionRenders).toBe(plainRenders);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });
  it('loads the real QR src and retains it while the same authorization operation polls', async () => {
    const { dom, w, action, errors } = await boot();
    const field = {
      key: 'auth',
      label: 'Authorize',
      kind: 'operation',
      operation: 'login',
      actions: [
        { id: 'qr', label: 'QR', render: 'button', resultRender: 'img', next: 'poll' },
        { id: 'poll', label: 'Wait', render: 'polling', timeout: 60 },
      ],
    };
    action.mockImplementation(async (name, args) =>
      args.action === 'qr'
        ? { ok: true, render: 'img', data: { url: 'data:image/png;base64,b3duZXI=' }, label: 'Scan owner code' }
        : { ok: true, render: 'polling', data: { status: 'pending' } },
    );
    w.qrField = field;
    try {
      w.eval(
        "pcfModel('qr-owner',{plugin:'dev.owner',fields:[qrField],refresh:function(){return Promise.resolve();}})",
      );
      await w.eval("pcfRun('qr-owner',qrField,'qr')");
      expect(w.eval("pcfOpVM('qr-owner',qrField).last.data.url")).toBe('data:image/png;base64,b3duZXI=');
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(w.eval("pcfOpVM('qr-owner',qrField).last.data.url")).toBe('data:image/png;base64,b3duZXI=');
      expect(action.mock.calls.filter(([name]) => name === 'pluginOperation')).toHaveLength(2);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('renders canonical sidebar groups and keeps organize drafts on owner rejection before submitting the original snapshot', async () => {
    const project = {
      sidebarOwner: {
        classification: { phase: 'idle', suggestions: [], newLabels: [], error: '' },
        preferences: {
          groups: [{ id: 'attention_owner', name: 'Owner group', threadIds: ['pdl-test', 'other'] }],
          aliases: {},
          open: {},
        },
        labels: [],
        runningThreadIds: [],
      },
    };
    const { dom, w, action, errors } = await boot(
      undefined,
      (data) => {
        data.threads.push({ ...data.threads[0], id: 'other', title: 'Other owner thread' });
      },
      undefined,
      project,
    );
    try {
      expect(w.document.querySelector('[data-sec="grp:attention_owner"]')?.textContent).toContain('Owner group');
      await w.eval('A.cafeAutoClassify()');
      expect(w.eval('VM.chatModal().view')).toBe('modal.classify');
      expect(action).toHaveBeenLastCalledWith('clSuggest', { ids: '' }, undefined);
      expect(action.mock.calls.filter(([name]) => name === 'sidebarLabels' || name === 'sidebarGroupWrite')).toEqual(
        [],
      );
      w.eval('CS.modal=null;render(true)');
      declaredMenu(w, 'modal', '[data-sec="grp:attention_owner"] ');
      w.document.querySelector('[data-pop="menu"] [data-v="org"]').click();
      await w.__settled();
      expect(w.eval('VM.chatModal().view')).toBe('modal.org');
      expect(w.document.querySelector('[data-pop="chat.modal"]')?.textContent).toContain('Other owner thread');
      w.document.querySelector('[data-pop="chat.modal"] [data-act="pick"][data-id="pdl-test"]').click();
      action.mockImplementationOnce(async () => {
        throw new Error('Group changed on owner');
      });
      await w.eval('FORMS.cafeModal()');
      await w.__settled();
      expect(w.eval('CS.modal.sel')).toEqual({ 'pdl-test': true });
      expect(w.document.querySelector('[data-pop="chat.modal"]')?.textContent).toContain('Group changed on owner');
      action.mockImplementationOnce(async () => undefined);
      await w.eval('FORMS.cafeModal()');
      await w.__settled();
      expect(action).toHaveBeenLastCalledWith('sidebarGroupWrite', {
        value: JSON.stringify({
          action: 'organize',
          threadIds: ['pdl-test'],
          expectedGroups: [{ id: 'attention_owner', threadIds: ['pdl-test', 'other'] }],
          groupId: 'attention_owner',
        }),
      });
      expect(w.eval('CS.modal')).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('renders native update state in the declared system section and waits for the install owner', async () => {
    const prompt = { kind: 'ready-to-install', version: '1.3.0' };
    const project = {
      desktopAvailable: true,
      desktopUpdateState: { load: '', prompt, progress: null, settings: { autoCheck: true } },
      desktopSystem: {
        load: '',
        app: { desktop: true, version: '1.2.0' },
        desktopAuto: true,
        update: {
          version: '1.3.0',
          state: '',
          canDownload: false,
          canInstall: true,
          sections: { progress: false },
          progress: [],
        },
      },
    };
    const { dom, w, action, errors } = await boot(undefined, undefined, undefined, project);
    action.mockImplementation(async (name) =>
      name === 'pushClientRead'
        ? { isSupported: false, permission: 'unsupported', isSubscribed: false, worker: 'unsupported' }
        : undefined,
    );
    try {
      w.eval("go('system')");
      await w.__settled();
      expect(w.document.getElementById('sys-update')?.textContent).toContain('1.2.0');
      await w.eval("A.desktopUpdate({op:'check'})");
      expect(action).toHaveBeenLastCalledWith('desktop:check', {}, undefined);
      await w.eval("A.toggle({path:'s.desktopUpdate.settings.autoCheck'})");
      expect(action).toHaveBeenLastCalledWith('desktop:autoCheck', { autoCheck: false }, undefined);
      w.eval("A.desktopUpdate({op:'install'})");
      expect(action).not.toHaveBeenCalledWith('desktop:action', expect.anything());
      action.mockImplementationOnce(async () => {
        throw new Error('native owner refused install');
      });
      await w.eval('dialogSubmit(S.dialog)');
      expect(w.document.querySelector('.dialog')?.textContent).toContain('native owner refused install');
      await w.eval('dialogSubmit(S.dialog)');
      await w.__settled();
      expect(action).toHaveBeenLastCalledWith('desktop:action', { action: 'install', version: '1.3.0' });
      expect(w.document.querySelector('.dialog')).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('renders one expandable paired tool row from existing details and metadata, actual group icons and live following', async () => {
    const { dom, w, errors } = await boot(undefined, (data, ui) => {
      ui.execOpen['reply-1'] = true;
      Object.assign(data.messages[1], {
        isStreaming: true,
        thinking: 'Owner thought',
        toolEvents: [
          {
            id: 'use',
            type: 'tool_use',
            toolUseId: 'native',
            executionRef: 'turn',
            toolName: 'read_file',
            label: 'Read source',
            detail: '{"path":"src/owner.ts"}',
            timestamp: 1,
          },
          {
            id: 'result',
            type: 'tool_result',
            toolUseId: 'native',
            executionRef: 'turn',
            label: 'Result',
            detail: '<script>literal owner output</script>',
            resultMeta: 'Owner metadata',
            status: 'error',
            timestamp: 2,
          },
        ],
      });
    });
    try {
      const rows = [...w.document.querySelectorAll('.lr')].filter((row) =>
        row.querySelector('.lr-head')?.textContent.includes('read_file'),
      );
      expect(rows).toHaveLength(1);
      rows[0].querySelector('.lr-head').click();
      await w.__settled();
      expect(w.document.querySelector('[data-mid="reply-1"]').textContent).toContain('src/owner.ts');
      const record = w.document.querySelector('[data-mid="reply-1"]');
      expect(record.textContent).toContain('Owner metadata');
      expect(record.textContent).toContain('<script>literal owner output</script>');
      expect(record.querySelector('script')).toBeNull();
      const parts = w.eval(
        'chatMessageVM(chatRead("chatStream").items.find(function(m){return m.mid==="reply-1";})).exec.groups[2].items[0].details',
      );
      expect(parts.map((p: { source: { part: string } }) => p.source.part)).toEqual([
        'call',
        'input',
        'result',
        'meta',
      ]);
      expect(parts[2].source).toMatchObject({
        kind: 'cli_output',
        toolUseId: 'native',
        executionRef: 'turn',
        part: 'result',
      });
      expect(record.querySelector('.stick-end')).not.toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('uses the shared recent-work view below component-owned recent tabs and opens command details in live', async () => {
    const source = {
      home: fixtureHomeSource(),
      recentWorks: {
        projectId: '/project',
        load: '',
        artifacts: [
          {
            navigationId: 'owner-work',
            name: 'Recent owner work',
            type: 'file',
            catId: 'codex',
            createdAt: 1,
            threadTitle: 'Source',
          },
        ],
      },
    };
    const { dom, w, action, errors } = await boot(undefined, undefined, undefined, {}, undefined, {}, source);
    try {
      w.eval("ENGINE_PARTS.openTab('panel','home')");
      await w.__settled();
      expect(w.document.querySelector('.panel-body').textContent).toContain('Recent owner work');
      expect(w.document.querySelector('.panel-body').textContent).toContain('最近打开');
      expect(w.eval('REGION_TABS.panel.order')).toBeUndefined();
      w.eval("ENGINE_PARTS.tabPin('panel','preview')");
      expect(w.eval("rtItemPinned('panel','preview')")).toBe(true);
      expect(JSON.parse(w.localStorage.getItem('clowder-proto3:rtMenu')).panel.pins).toContain('preview');
      await w.eval("A.execOpen({k:'managed'})");
      await w.__settled();
      expect(w.eval("rtCur('panel')")).toBe('live');
      expect(action).toHaveBeenCalledWith('homeExecOpen', { k: 'managed' }, undefined);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('loads a src-only plugin workbench tool from its declared entry metadata without a route or another painter', async () => {
    const plugin = {
      pluginId: 'dev.pdl-tool',
      displayName: 'Plugin Tool',
      icon: 'code',
      artifact: 'installed',
      intent: 'enabled',
      actions: {},
      source: { kind: 'local-archive' },
    };
    const fragment = {
      id: 'pdl-tool',
      inserts: [
        {
          id: 'srcTool',
          anchor: 'panel.tools',
          at: 'inside',
          node: { title: 'Source tool', icon: 'code', group: 'code', open: { node: 'test.toolFrame' } },
        },
      ],
      views: { 'test.toolFrame': { type: 'frame', src: 'https://tool.test/client/' } },
    };
    const { dom, w, errors } = await boot(undefined, undefined, undefined, {}, (port) => {
      const original = port.get;
      port.get = async (path, params) =>
        path === '/api/plugin-manager/plugins'
          ? { plugins: [plugin] }
          : path === '/api/plugin-manager/pdl'
            ? { fragments: { [plugin.pluginId]: fragment } }
            : original(path, params);
    });
    try {
      expect(w.eval('PANEL_VIEWS["test.toolFrame"].slice(0,2)')).toMatchObject(['Source tool', 'code']);
      w.eval("ENGINE_PARTS.openTab('panel','test.toolFrame')");
      await w.__settled();
      expect(w.document.querySelector('iframe[src="https://tool.test/client/"]')).not.toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('re-registers a plugin package when it is updated and removes it when it is uninstalled', async () => {
    const plugin = {
      pluginId: 'dev.pdl-tool',
      displayName: 'Plugin Tool',
      icon: 'code',
      artifact: 'installed',
      intent: 'enabled',
      actions: {},
      source: { kind: 'local-archive' },
    };
    const declared = (title: string) => ({
      id: 'pdl-tool',
      inserts: [
        {
          id: 'srcTool',
          anchor: 'panel.tools',
          at: 'inside',
          node: { title, icon: 'code', group: 'code', open: { node: 'test.toolFrame' } },
        },
      ],
      views: { 'test.toolFrame': { type: 'frame', src: 'https://tool.test/client/' } },
    });
    let installed: Record<string, object> = { [plugin.pluginId]: declared('Source tool') };
    const { dom, w, errors } = await boot(undefined, undefined, undefined, {}, (port) => {
      const original = port.get;
      port.get = async (path, params) =>
        path === '/api/plugin-manager/plugins'
          ? { plugins: Object.keys(installed).length ? [plugin] : [] }
          : path === '/api/plugin-manager/pdl'
            ? { fragments: installed }
            : original(path, params);
    });
    const reread = async () => {
      w.clowderChat.emit('cat-cafe:plugin-operation-changed', {});
      await w.__settled();
    };
    try {
      expect(w.eval("pdlEntry('plugin:dev.pdl-tool/srcTool').title")).toBe('Source tool');
      installed = { [plugin.pluginId]: declared('Renamed tool') };
      await reread();
      expect(w.eval("pdlEntry('plugin:dev.pdl-tool/srcTool').title")).toBe('Renamed tool');
      expect(w.eval("PDL_PLUGINS.filter(function (k) { return k === 'dev.pdl-tool'; }).length")).toBe(1);
      installed = {};
      await reread();
      expect(
        w.eval(
          "[pdlEntry('plugin:dev.pdl-tool/srcTool'), PDL_VIEWS['test.toolFrame'], PDL_PLUGINS.indexOf('dev.pdl-tool')]",
        ),
      ).toEqual([null, undefined, -1]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('inserts a plugin node next to a public leaf of the theme and lists an insert that found no anchor', async () => {
    const plugin = {
      pluginId: 'dev.pdl-insert',
      displayName: 'Insert',
      icon: 'code',
      artifact: 'installed',
      intent: 'enabled',
      actions: {},
      source: { kind: 'local-archive' },
    };
    const button = { type: 'button', iconOnly: true, icon: 'plus', label: 'Insert', act: 'toast', args: { t: 'x' } };
    const fragment = {
      id: 'pdl-insert',
      inserts: [
        { id: 'beside-send', anchor: 'bar.send', at: 'before', node: button },
        { id: 'nowhere', anchor: 'no.such.leaf', at: 'after', node: button },
      ],
    };
    const { dom, w, errors } = await boot(undefined, undefined, undefined, {}, (port) => {
      const original = port.get;
      port.get = async (path, params) =>
        path === '/api/plugin-manager/plugins'
          ? { plugins: [plugin] }
          : path === '/api/plugin-manager/pdl'
            ? { fragments: { [plugin.pluginId]: fragment } }
            : original(path, params);
    });
    try {
      expect(
        w.eval(
          "(function () { var e = pdlAnchorFind(pdlTreeIndex(), { anchor: 'bar.send' })[0], i = e.list.indexOf(e.node); return e.list[i - 1].ins; })()",
        ),
      ).toBe('plugin:dev.pdl-insert/beside-send');
      expect(w.eval('JSON.stringify(PDL_INSERT_SKIPS["dev.pdl-insert"])')).toBe(
        JSON.stringify([{ id: 'nowhere', anchor: 'no.such.leaf', reason: 'missing' }]),
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('keeps a profile opening edit in the declared dialog until its actual writer succeeds and shows its rejection there', async () => {
    let finish!: () => void;
    const project = {
      cafeMemory: {
        detail: {
          profile: {
            openingReference: {
              asOf: '2026-11-03',
              excerpts: [{ kind: 'relationship', text: 'Original', source: { threadId: 't', messageId: 'm' } }],
            },
          },
        },
      },
    };
    const { dom, w, action, errors } = await boot(undefined, undefined, undefined, project);
    try {
      w.eval("A.cafeMemAct({op:'opening',id:'profile-one',expectedRevision:'rev-1'})");
      action.mockImplementationOnce(async () => {
        throw new Error('owner revision rejected');
      });
      await w.eval('dialogSubmit(S.dialog)');
      expect(w.document.querySelector('.dialog')?.textContent).toContain('owner revision rejected');
      expect(w.document.getElementById('memory-excerpt0')?.value).toBe('Original');
      action.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const saving = w.eval('dialogSubmit(S.dialog)');
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      expect(w.eval('S.dialog')).toBeNull(); // closed while its owner works; the trigger shows progress
      expect(action).toHaveBeenLastCalledWith('profileOpening', {
        op: 'edit',
        id: 'profile-one',
        expectedRevision: 'rev-1',
        asOf: '2026-11-03',
        texts: ['Original'],
      });
      finish();
      await saving;
      await w.__settled();
      expect(w.document.querySelector('.dialog')).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('uses declared member rows, subset order, one owner color and template dropdown with account-owned Codex credentials', async () => {
    const metadata = {
      accounts: [{ id: 'oauth-one', displayName: 'Codex Account', authType: 'oauth', models: [] }],
      templates: [{ id: 'maine', name: 'Maine' }],
      blank: initialState(),
      codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request', authMode: 'api_key' },
      strategies: [],
      runtimes: [],
      libraries: [],
      clients: CLIENT_OPTIONS.map((client) => ({
        id: client.value,
        label: client.label,
        carriers: carrierOptionsForClient(client.value).map((row) => [row.value, row.label]),
        accounts: ['oauth-one'],
      })),
    };
    const { dom, w, action, errors } = await boot(
      undefined,
      (data) => {
        Object.assign(data.cats[0], {
          clientId: 'openai',
          carrier: 'app_server',
          name: 'Codex',
          nickname: 'C',
          roleDescription: 'Code',
          personality: '',
          accountRef: 'oauth-one',
          configurationRevision: 'rev-1',
        });
        Object.assign(data.me, {
          name: 'Owner',
          aliases: ['Owner'],
          nickname: 'Partner',
          mentionPatterns: ['@owner', '@partner'],
          avatar: '/avatars/owner.png',
          color: { primary: '#527b99', secondary: '#abcdef' },
        });
      },
      undefined,
      {},
      (port) => {
        const previous = port.action;
        port.action = async (name, args, element) =>
          name === 'membersRead' ? metadata : name === 'memberSave' ? { id: 'codex' } : previous(name, args, element);
      },
    );
    try {
      w.eval("go('members')");
      await vi.waitFor(() => expect(w.document.querySelector('[data-order-act="umOrder"]')).not.toBeNull());
      await w.eval("A.umOrder({keys:['codex']})");
      expect(action).toHaveBeenCalledWith('umOrder', { keys: ['codex'] }, undefined);
      expect(w.eval('WHO_DATA.me()')).toMatchObject({
        color: { primary: '#527b99', secondary: '#abcdef' },
        avatarPath: '/avatars/owner.png',
      });
      expect(w.eval("whoInfo({kind:'user',userId:'owner'}).color")).toBe(
        w.eval("'oklch(from var(--name-1) l c ' + senderHue('#527b99') + ')'"),
      );
      w.eval('A.ownerOpen()');
      expect(w.document.querySelectorAll('.dialog .color-wrap')).toHaveLength(1);
      w.eval("A.chipAdd({for:'ow-alias',kind:'',v:'Second'}); A.chipDel({for:'ow-alias',v:'Owner'});");
      await w.eval('S.dialog.on()');
      const saved = JSON.parse(action.mock.calls.find(([name]) => name === 'ownerSave')![1].value);
      expect(saved).toEqual({
        name: 'Owner',
        aliases: ['Second'],
        mentionPatterns: ['@owner', '@partner'],
        avatar: '/avatars/owner.png',
        color: { primary: '#527b99', secondary: '#abcdef' },
      });
      w.eval("S.dialog.fields.find(f => f.id === 'ow-nickname').value='New partner'");
      await w.eval('S.dialog.on()');
      expect(JSON.parse(action.mock.calls.filter(([name]) => name === 'ownerSave').at(-1)![1].value).nickname).toBe(
        'New partner',
      );
      w.eval("S.dialog.fields.find(f => f.id === 'ow-nickname').value=''");
      await w.eval('S.dialog.on()');
      expect(
        JSON.parse(action.mock.calls.filter(([name]) => name === 'ownerSave').at(-1)![1].value).nickname,
      ).toBeNull();
      w.eval("S.dialog=null; go('member-codex')");
      await vi.waitFor(() => expect(w.document.getElementById('f-cxSandbox')).not.toBeNull());
      expect(w.document.getElementById('f-cxApproval')).not.toBeNull();
      expect(w.document.getElementById('f-cxCred')).toBeNull();
      expect(w.document.getElementById('f-authMode')).toBeNull();
      w.eval("go('memberNew')");
      await vi.waitFor(() => expect(w.document.getElementById('mn-tpl')).not.toBeNull());
      expect(w.eval('VM.memberNew().templates')).toEqual(metadata.templates);
      expect(w.document.querySelector('[data-act="pickAvatar"]')).toBeNull();
      await w.__settled();
      let uploaded!: (url: string) => void;
      action.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            uploaded = resolve;
          }),
      );
      const upload = w.document.querySelector('#mform .ava-up input');
      Object.defineProperty(upload, 'files', { value: [new w.File(['avatar'], 'avatar.png', { type: 'image/png' })] });
      upload.dispatchEvent(new w.Event('change', { bubbles: true }));
      await vi.waitFor(() => expect(uploaded).toBeTypeOf('function'));
      w.eval("go('member-codex')");
      uploaded('/uploads/new-member-avatar.png');
      await w.__settled();
      expect(w.eval('VM.member().form.d.avatarPath')).toBe('');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('keeps unknown agent identities from their own from name or id without borrowing another member', async () => {
    const { dom, w, errors } = await boot(undefined, (data) => {
      const source = data.messages.find((message) => message.type === 'assistant')!;
      source.catId = 'removed-member';
      source.from = Object.assign(
        { kind: 'agent' as const, catId: 'removed-member' },
        { name: 'Recorded member name' },
      );
    });
    try {
      expect(w.eval("whoInfo({kind:'agent',catId:'removed-member',name:'Recorded member name'}).name")).toBe(
        'Recorded member name',
      );
      expect(w.eval("whoInfo({kind:'agent',catId:'other-missing'}).name")).toBe('other-missing');
      expect(w.document.querySelector('[data-mid="reply-1"]')?.textContent).toContain('Recorded member name');
      expect(w.eval("WHO_DATA.member('codex','Old sender name').name")).toBe('Codex');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('registers admitted plugin entries, placement and view or src spaces and refreshes enable intent from the owner', async () => {
    const plugin = {
      pluginId: 'dev.clowder.spaces',
      displayName: 'Spaces',
      icon: 'box',
      artifact: 'installed',
      intent: 'enabled',
      installedVersion: '1.0.0',
      availableVersion: null,
      lifecycleRevision: 4,
      source: { kind: 'local-archive' },
      actions: { setEnabled: true, uninstall: true },
    };
    const fragments = {
      [plugin.pluginId]: {
        id: 'spaces',
        inserts: ['client', 'view'].map((key) => ({
          id: key,
          anchor: 'rail.top',
          at: 'inside',
          node: {
            icon: 'box',
            title: key === 'client' ? 'Client space' : 'View space',
            open: { node: key === 'client' ? 'spaces.client' : 'spaces.body' },
          },
        })),
        views: {
          'spaces.client': {
            type: 'frame',
            route: 'plug-dev.clowder.spaces',
            src: 'https://client.test/?hostOrigin=https%3A%2F%2Fpdl.test',
          },
          'spaces.body': {
            route: 'plugin-view',
            vm: 'chatHeader',
            blocks: [{ type: 'text', text: 'Plugin-owned declaration' }],
          },
        },
      },
    };
    const writes: unknown[] = [];
    const { dom, w, errors } = await boot(undefined, undefined, undefined, {}, (port) => {
      const original = port.get;
      port.get = async (path) =>
        path === '/api/plugin-manager/plugins'
          ? { plugins: [structuredClone(plugin)] }
          : path === '/api/plugin-manager/pdl'
            ? { fragments: structuredClone(fragments) }
            : path === '/api/plugin-manager/plugins/' + plugin.pluginId
              ? { plugin: { ...structuredClone(plugin), configFields: [], capabilities: [] } }
              : original(path);
      port.post = async (path, _params, body) => {
        writes.push({ path, body });
        plugin.intent = (body as { enabled: boolean }).enabled ? 'enabled' : 'disabled';
        plugin.lifecycleRevision++;
      };
    });
    try {
      expect(w.document.querySelector('[data-entry="plugin:dev.clowder.spaces/client"]')).not.toBeNull();
      w.document.querySelector('[data-entry="plugin:dev.clowder.spaces/client"]').click();
      await w.__settled();
      expect(w.document.querySelector('[data-view="page.plug"] iframe')?.getAttribute('src')).toContain(
        'https://client.test/',
      );
      expect(w.location.hash).toBe('#plug-dev.clowder.spaces');
      await w.eval("A.togglePlugin({k:'dev.clowder.spaces'})");
      await w.__settled();
      expect(w.document.querySelector('[data-entry="plugin:dev.clowder.spaces/client"]')).toBeNull();
      expect(w.document.querySelector('[data-view="page.plug"] iframe')).toBeNull();
      expect(writes[0]).toEqual({
        path: '/api/plugin-manager/plugins/dev.clowder.spaces/set-enabled',
        body: { enabled: false, expectedRevision: 4 },
      });
      fragments[plugin.pluginId]!.views['spaces.client'].src = 'https://new-client.test/';
      await w.eval("A.togglePlugin({k:'dev.clowder.spaces'})");
      w.eval("A.open({ref:'plugin:dev.clowder.spaces/view'})");
      await w.__settled();
      expect(w.document.querySelector('[data-view="spaces.body"]')?.textContent).toContain('Plugin-owned declaration');
      w.eval("go('plug-dev.clowder.spaces')");
      await w.__settled();
      expect(w.document.querySelector('[data-view="page.plug"] iframe')?.getAttribute('src')).toBe(
        'https://new-client.test/',
      );
      w.eval("go('extItem-dev.clowder.spaces')");
      await w.__settled();
      expect(w.document.querySelector('[data-view="page.ext"]')?.textContent).toContain('Spaces');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('keeps appearance preferences and complete custom theme documents in the original local store with no server writes', async () => {
    const { dom, w, action, errors } = await boot(undefined, undefined, undefined, {}, undefined, {
      tweaks: { theme: 'dark', compact: false },
      layout: 'two',
      'background-v1': { home: 'none', homeTr: 72, images: [] },
    });
    try {
      w.eval("A.open({page:'appearance'})");
      await w.__settled();
      expect(w.document.querySelector('[data-view="page.theme"]')).not.toBeNull();
      expect(w.eval('S.tweaks.theme')).toBe('dark');
      expect(w.eval('S.layout')).toBe('two');
      expect(w.eval('VM.themeBg().home')).toBe('none');
      w.eval("A.set({path:'s.tweaks.theme',v:'light'})");
      expect(JSON.parse(w.localStorage.getItem('clowder-proto3:tweaks')).theme).toBe('light');
      w.document.querySelector('[data-entity="style"][data-field="readSize"][data-v="17"]').click();
      await w.__settled();
      w.eval("themeValsEdit(S.tweaks.skin,function(v){v.light.accent='#527b99'});applyThemeVals()");
      const themes = JSON.parse(w.localStorage.getItem('clowder-proto3:pdl-themes-v1'));
      expect(themes.customs[0].full.style.readSize).toBe('17');
      expect(themes.customs[0].full.tokens.cream.light.accent).toBe('#527b99');
      w.eval("CHANGES.bgPick({target:{value:'bg.night'}}); INPUTS.bgOp({target:{value:'42'}})");
      w.document.querySelector('[data-input="bgOp"]').dispatchEvent(new w.Event('change', { bubbles: true }));
      expect(JSON.parse(w.localStorage.getItem('clowder-proto3:background-v1'))).toMatchObject({
        home: 'bg.night',
        homeTr: 58,
      });
      expect(action).not.toHaveBeenCalledWith('appearanceSave', expect.anything());
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('exposes retained per-thread background data for v2 while the default theme intentionally reads only the local global choice', async () => {
    const legacy = {
      threads: {
        'pdl-test': {
          kind: 'image',
          url: '/uploads/private.png',
          name: 'Private',
          placement: 'fill',
          opacity: { light: 0.1, dark: 0.1 },
          recommendedOpacity: { light: 0.1, dark: 0.1 },
        },
      },
    };
    const { dom, w, port, errors } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      (port) => {
        const get = port.get;
        port.get = (path, params) =>
          path === '/api/config/chat-background' ? Promise.resolve(legacy) : get(path, params);
      },
      { 'background-v1': { home: 'none', homeTr: 72, images: [] } },
    );
    try {
      expect(w.eval('VM.chatBackgrounds()')).toBeNull();
      w.eval(
        'const backgroundConsumer=VM.chatStream; VM.chatStream=function(){VM.chatBackgrounds();return backgroundConsumer();};render(true);',
      );
      await w.__settled();
      expect(w.eval('VM.chatBackgrounds()')).toEqual(legacy);
      expect(w.eval('VM.themeBg().home')).toBe('none');
      expect(JSON.stringify(w.eval('bgState()'))).not.toContain('private.png');
      expect(port.post).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('renders actual profile opening modes and usage types through the existing memory detail without mutating owner data', async () => {
    let project = {
      memoryState: { view: 'all', cat: 'profile', q: '', limits: { profile: 20 } },
      cafeMemory: {
        all: null,
        detail: {
          id: 'profile-owner',
          title: 'Owner profile',
          fields: [],
          sections: {},
          profile: {
            usage: { openingMode: 'enabled' },
            usageCounts: [],
            usageRows: [{ id: 'owner-event', title: 'read', kind: 'read', at: 'Owner time', act: '' }],
          },
        },
      },
    };
    const { dom, w, errors, port } = await boot(undefined, undefined, undefined, () => project);
    try {
      w.eval("go('memory')");
      await w.eval("A.memOpen({ family:'profile',id:'profile-owner'})");
      for (const mode of ['enabled', 'on_demand']) {
        project = {
          ...project,
          cafeMemory: {
            ...project.cafeMemory,
            detail: {
              ...project.cafeMemory.detail,
              profile: { ...project.cafeMemory.detail.profile, usage: { openingMode: mode } },
            },
          },
        };
        port.data = { ...port.data };
        w.clowderChat.update(port);
        await w.__settled();
        const view = w.eval('VM.cafeMemory()');
        expect(view.detail.profile.usage.openingMode).toBe(mode);
        expect(view.detail.profile.usageRows[0]).toMatchObject({ kind: 'read', at: 'Owner time' });
        expect(w.document.querySelector('[data-view="cafe.memory"] .kvg')?.textContent).toContain(
          mode === 'enabled' ? '启用' : '按需回看',
        );
      }
      expect(project.cafeMemory.detail.fields).toEqual([]);
      expect(project.cafeMemory.detail.profile.usageRows[0].title).toBe('read');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('renders only the declared restore action and waits for its owner before removing a trash row', async () => {
    const project = {
      cafeTrash: {
        items: [{ id: 'deleted-owner', title: null, time: 'Owner deletion time', ctx: { id: 'deleted-owner' } }],
      },
    };
    const { dom, w, action, errors, port } = await boot(undefined, undefined, undefined, project);
    try {
      w.eval("go('trash')");
      await w.__settled();
      const page = w.document.querySelector('[data-view="cafe.trash"]');
      expect(page.textContent).toContain(w.eval("tc('chat.thread.trash.untitled')"));
      expect(page.textContent).not.toContain(w.eval("tc('trash.desc')"));
      expect(page.querySelector('[data-entity="trash"]')).toBeNull();
      const restore = page.querySelector('[data-act="remove"][data-entity="trashRestore"]');
      expect(restore).not.toBeNull();
      let acknowledge!: () => void;
      action.mockImplementation(async (name, args) => {
        if (name !== 'trashRestore') return;
        expect(args).toEqual({ id: 'deleted-owner' });
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
        project.cafeTrash.items = [];
        w.clowderChat.update(port);
      });
      restore.click();
      await vi.waitFor(() => expect(action).toHaveBeenCalledWith('trashRestore', { id: 'deleted-owner' }, undefined));
      expect(w.document.querySelector('[data-view="cafe.trash"]').textContent).toContain('Owner deletion time');
      acknowledge();
      await vi.waitFor(() =>
        expect(w.document.querySelector('[data-view="cafe.trash"]').textContent).toContain(
          w.eval("tc('trash.isEmpty')"),
        ),
      );
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('renders r126 file media and generic Office metadata through the original file view', async () => {
    const media = {
      id: 'file:/project/owner.png',
      kind: 'image',
      src: 'https://api.test/api/workspace/file/raw?worktreeId=wt&path=owner.png',
      label: 'owner.png',
      marks: [],
    };
    const file = {
      path: 'owner.png',
      absolutePath: '/project/owner.png',
      binary: true,
      mime: 'image/png',
      content: '',
      sha256: 'owner-image',
    };
    const bench = {
      ...fixtureWorkbenchSource(),
      opened: { worktreeId: 'wt', file },
      workspace: {
        worktreeId: 'wt',
        worktrees: [{ id: 'wt', root: '/project' }],
        tree: [],
        loading: false,
        error: null,
      },
    };
    const { dom, w, errors } = await boot(undefined, undefined, undefined, {}, undefined, {}, { workbench: bench });
    try {
      await w.eval("A.wsFile({ p:'owner.png',w:'wt'})");
      await w.__settled();
      const page = () => w.document.querySelector('[data-view="file.body"]');
      expect(page()).not.toBeNull();
      expect(page().querySelector('img')?.getAttribute('src')).toBe(media.src);
      expect(page().querySelector('pre')).toBeNull();
      w.clowderChat.pushProject({
        workbench: {
          ...bench,
          opened: {
            worktreeId: 'wt',
            file: {
              ...file,
              path: 'owner.pptx',
              absolutePath: '/project/owner.pptx',
              mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              size: 2048,
              pageCount: 3,
              pageUnit: 'slides',
            },
          },
        },
      });
      await w.__settled();
      expect(page().textContent).toContain(w.eval("tc('workbench.file.noPreview')"));
      expect(page().textContent).toContain(w.eval("tc('workbench.fileInfoField.size')"));
      expect(page().textContent).toContain(w.eval("tc('workbench.fileInfoField.slides')"));
      expect(page().textContent).toContain('2 KB');
      expect(page().querySelector('pre,video,audio,img')).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('groups real thread project paths through the existing sidebar declaration and preserves literal collapse keys', async () => {
    const alpha = '/project/alpha.owner';
    const beta = '/project/beta';
    const { dom, w, ui, errors } = await boot(undefined, (data, state) => {
      state.group = 'project';
      data.threads[0].projectPath = alpha;
      data.threads[0].labels = ['selected'];
      data.threads.push(
        { ...data.threads[0], id: 'alpha-2', labels: [], title: 'Another Alpha' },
        { ...data.threads[0], id: 'beta', labels: [], projectPath: beta, title: 'Beta owner' },
        { ...data.threads[0], id: 'deleted', deletedAt: 1, title: 'Deleted owner' },
        { ...data.threads[0], id: 'system', systemKind: 'memory_ops', title: 'System owner' },
      );
    });
    try {
      const sections = () => w.eval('VM.navThreads().sections');
      expect(w.eval('VM.cafeNavShell().byProject')).toBe(true);
      expect(sections().map((s: { head: { id: string; n: number } }) => [s.head.id, s.head.n])).toEqual([
        [alpha, 2],
        [beta, 1],
      ]);
      const toggle = w.document.querySelector(`[data-path="cs.projOpen.{id}"][data-id="${alpha}"]`);
      expect(toggle).not.toBeNull();
      toggle.click();
      await w.__settled();
      expect(ui.projOpen?.[alpha]).toBe(false);
      expect(sections()[0].collapsed).toBe(true);
      expect(Object.keys(ui.projOpen!)).toEqual([alpha, beta]);
      w.document.querySelector('[data-path="cs.projAll"][data-v="1"]').click();
      await w.__settled();
      expect(sections().every((s: { collapsed: boolean }) => !s.collapsed)).toBe(true);
      w.document.querySelector('[data-path="cs.projAll"][data-v="0"]').click();
      await w.__settled();
      expect(sections().every((s: { collapsed: boolean }) => s.collapsed)).toBe(true);
      w.eval("A.set({path:'cs.tag',v:'selected'})");
      await w.__settled();
      expect(sections()).toHaveLength(1);
      expect(sections()[0].head.n).toBe(1);
      w.eval("A.set({path:'cs.group',v:'recent'})");
      await w.__settled();
      expect(w.eval('VM.cafeNavShell().byProject')).toBe(false);
      expect(ui.projOpen?.[alpha]).toBe(false);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('reads project pins and display names from the real preference snapshot and dispatches their existing writers', async () => {
    const first = '/project/unpinned.owner',
      pinned = '/project/pinned.owner';
    const { dom, w, data, action, errors } = await boot(undefined, (data, ui) => {
      ui.group = 'project';
      data.threads[0].projectPath = first;
      data.threads.push({ ...data.threads[0], id: 'pinned-thread', projectPath: pinned });
      data.projectPins = new Set([pinned]);
      data.projectNames = new Map([[pinned, 'Owner project name']]);
    });
    try {
      const sections = () => w.eval('VM.navThreads().sections');
      expect(
        sections().map((section: { head: { id: string; fixed: boolean } }) => [section.head.id, section.head.fixed]),
      ).toEqual([
        [pinned, true],
        [first, false],
      ]);
      expect(w.document.querySelector('[data-view="nav.threads"]').textContent).toContain('Owner project name');
      w.eval(`S.menuTarget=${JSON.stringify(pinned)}`);
      expect(declaredMenu(w, 'reveal', '[data-view="nav.threads"] ')).toMatchObject([
        { act: 'setStatus', data: { entity: 'proj', id: pinned, field: 'pinned' } },
        { act: 'reveal', data: { path: pinned } },
        { act: 'rename', data: { entity: 'proj', id: pinned } },
        { act: 'remove', data: { entity: 'proj', id: pinned } },
      ]);
      await w.eval(`A.setStatus({entity:'proj',id:${JSON.stringify(pinned)},field:'pinned'})`);
      await w.__settled();
      expect(action).toHaveBeenCalledWith('projectPin', { id: pinned, v: 'false' }, undefined);
      // UI follows the owner snapshot, not entity-object mutation or menu clicks alone.
      expect(sections()[0].head.fixed).toBe(true);
      data.projectPins = new Set();
      w.clowderChat.pushSidebar(fixtureSidebar(data));
      await w.__settled();
      expect(
        sections().map((section: { head: { id: string; fixed: boolean } }) => [section.head.id, section.head.fixed]),
      ).toEqual([
        [first, false],
        [pinned, false],
      ]);
      await w.eval(`ENT.proj.rename(ENT.proj.get(${JSON.stringify(pinned)}),'Renamed by owner')`);
      expect(action).toHaveBeenCalledWith('projectRename', { id: pinned, v: 'Renamed by owner' }, undefined);
      data.projectNames = new Map([[pinned, 'Renamed by owner']]);
      w.clowderChat.pushSidebar(fixtureSidebar(data));
      await w.__settled();
      expect(sections()[1].head.name).toBe('Renamed by owner');
      expect(data.threads[1].projectPath).toBe(pinned);
      expect(data.threads[1].title).toBe('对话绑定验收');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('opens the owner source thread from the declared task row action and respects rejected navigation', async () => {
    const source = {
      id: 'source-task',
      kind: 'work',
      threadId: 'owner-thread',
      sourceMessageId: 'owner-message',
      subjectKey: null,
      title: 'Task with owner source',
      status: 'todo',
      why: 'Owner instruction',
      ownerCatId: null,
      createdBy: 'user',
      createdAt: 1,
      updatedAt: 1,
    };
    const { dom, w, action, errors } = await boot(
      undefined,
      undefined,
      undefined,
      { workbenchState: { tkF: 'all' } },
      undefined,
      {},
      { workbench: { ...fixtureWorkbenchSource(), tasks: [source] } },
    );
    try {
      w.eval("ENGINE_PARTS.openTab('panel', 'tasks')");
      await w.__settled();
      const trigger = w.document.querySelector('[data-act="sourceOpen"]');
      expect(trigger).not.toBeNull();
      trigger.click();
      await vi.waitFor(() => expect(action).toHaveBeenCalledWith('thread', { id: 'owner-thread' }, undefined));
      expect(w.eval('S.route')).toBe('chat');
      action.mockClear();
      w.eval("go('system')");
      await w.__settled();
      action.mockResolvedValueOnce(false);
      await w.eval("A.sourceOpen({ t:'unreadable-thread'})");
      expect(action).toHaveBeenCalledWith('thread', { id: 'unreadable-thread' }, undefined);
      expect(w.eval('S.route')).toBe('system');
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('opens the real author member card through r124 declarations and inserts its actual handle', async () => {
    const { dom, w, ui, action, errors } = await boot(undefined, (data) => {
      data.cats[0].nickname = 'Owner nickname';
      data.cats[0].breedDisplayName = 'Owner breed';
      data.cats[0].roleDescription = 'Owner role';
      data.cats[0].defaultModel = 'Owner model';
      data.cats[0].mentionPatterns = ['@owner-handle'];
    });
    try {
      for (const key of ['memberCard', 'chat.pop', 'media', 'clip.preview', 'theater']) {
        expect(w.eval(`POPUPS[${JSON.stringify(key)}]`)).toBeUndefined();
        expect(w.eval(`PDL_POPUPS[${JSON.stringify(key)}].view`)).toBeTruthy();
      }
      const trigger = w.document.querySelector('[data-mid="reply-1"] [data-hover="memberCard"][data-who="codex"]');
      expect(trigger).not.toBeNull();
      const matches = trigger.matches.bind(trigger);
      vi.spyOn(trigger, 'matches').mockImplementation((s) => s === ':hover' || matches(s));
      trigger.dispatchEvent(new w.MouseEvent('mouseover', { bubbles: true }));
      await vi.waitFor(() => expect(ui.memberCard).toBe('codex'));
      await w.__settled();
      const card = w.document.querySelector('[data-pop="memberCard"]');
      expect(card.querySelector('[data-view="member.card"]')?.textContent).toContain('Owner nickname');
      expect(card.textContent).toContain('Owner breed');
      expect(card.textContent).toContain('@owner-handle');
      expect(card.textContent).toContain('Owner model');
      expect(card.textContent).toContain('Owner role');
      expect(card.querySelector('[role="dialog"]').getAttribute('aria-label')).toBe('Owner nickname');
      card.querySelector('[data-act="mention"]').click();
      await vi.waitFor(() => expect(action).toHaveBeenCalledWith('compose', { v: '@owner-handle ', pos: '14' }));
      expect(ui.memberCard).toBeNull();
      expect(w.document.querySelector('[data-pop="memberCard"]')).toBeNull();
      await w.eval("A.memberCard({ who:'codex'})");
      await w.__settled();
      expect(w.document.querySelector('[data-pop="memberCard"]')).not.toBeNull();
      w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await w.__settled();
      expect(ui.memberCard).toBeNull();
      expect(w.document.querySelector('[data-pop="memberCard"]')).toBeNull();
      await w.eval("A.memberCard({ who:'no-owner'})");
      await w.__settled();
      expect(w.document.querySelector('[data-pop="memberCard"]')).toBeNull();
      expect(errors).not.toHaveBeenCalled();
      expect(w.eval('TOAST_LOG')).toEqual([]);
    } finally {
      dom.window.close();
    }
  });
  it('renders two independently selectable screenings and dispatches the result comparison through the copied film view', async () => {
    const primaryId = 'film:project:old',
      referenceId = 'film:project:new:reference';
    const film = contentRuntimeFilm();
    const state = {
      film: { layout: 'list', tab: 'review', assets: {}, compare: 'new', opinion: null },
      canon: { reason: '', target: '', bindingChoices: {} },
    };
    const { dom, w, action, errors } = await boot(
      undefined,
      undefined,
      undefined,
      { workbenchState: state },
      undefined,
      {},
      { film, canon: { threadId: 'pdl-test', reference: { contentRef: 'project', ownerRevision: 1 }, load: '' } },
    );
    const filmProject = w.eval('VM.filmProject()');
    try {
      w.eval("ENGINE_PARTS.openTab('panel', 'clips')");
      await w.__settled();
      w.document.querySelector('[data-view="cafe.ws.clips"] [data-act="filmOpen"]').click();
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith('filmOpen', expect.objectContaining({ id: 'project' }), undefined),
      );
      await w.__settled();
      await vi.waitFor(() => expect(w.document.querySelectorAll('[data-view="film.project"] video')).toHaveLength(2));
      await w.__settled();
      const left = w.document.querySelector(`[data-media="${primaryId}"]`),
        right = w.document.querySelector(`[data-media="${referenceId}"]`);
      expect(w.document.querySelectorAll('[data-view="film.project"] video')).toHaveLength(2);
      expect(JSON.parse(left.dataset.pick).args).toEqual({ id: 'project', screening: 'old', mediaId: primaryId });
      expect(JSON.parse(right.dataset.pick).args).toEqual({ id: 'project', screening: 'new', mediaId: referenceId });
      expect(left.dataset.mediaGroup).toBe('project');
      expect(right.dataset.mediaGroup).toBe('project');
      expect(left.hasAttribute('data-sync')).toBe(false);
      expect(right.hasAttribute('data-sync')).toBe(false);
      const leftVideo = left.querySelector('video'),
        rightVideo = right.querySelector('video'),
        leftPlay = vi.spyOn(leftVideo, 'play').mockResolvedValue(undefined),
        rightPlay = vi.spyOn(rightVideo, 'play').mockResolvedValue(undefined),
        leftPause = vi.spyOn(leftVideo, 'pause').mockImplementation(() => {}),
        rightPause = vi.spyOn(rightVideo, 'pause').mockImplementation(() => {});
      expect(leftVideo.controls).toBe(true);
      expect(rightVideo.controls).toBe(true);
      expect(rightVideo.muted).toBe(false);
      leftVideo.currentTime = 1;
      rightVideo.currentTime = 8;
      leftVideo.dispatchEvent(new w.Event('play', { bubbles: true }));
      leftVideo.dispatchEvent(new w.Event('timeupdate', { bubbles: true }));
      leftVideo.dispatchEvent(new w.Event('pause', { bubbles: true }));
      expect(rightVideo.currentTime).toBe(8);
      expect(rightPlay).not.toHaveBeenCalled();
      expect(rightPause).not.toHaveBeenCalled();
      w.document.querySelector('[data-act="mediaGroup"][data-op="play"]').click();
      expect(leftPlay).toHaveBeenCalledTimes(1);
      expect(rightPlay).toHaveBeenCalledTimes(1);
      expect(leftVideo.currentTime).toBe(1);
      expect(rightVideo.currentTime).toBe(8);
      w.document.querySelector('[data-act="mediaGroup"][data-op="pause"]').click();
      expect(leftPause).toHaveBeenCalledTimes(1);
      expect(rightPause).toHaveBeenCalledTimes(1);
      const point = w.document.querySelector('select[data-change="mediaGroupPoint"]');
      expect(point.dataset.group).toBe('project');
      expect([...point.options].map((o: HTMLOptionElement) => o.value)).toEqual(['', 'scene-1']);
      point.value = 'scene-1';
      point.dispatchEvent(new w.Event('change', { bubbles: true }));
      expect(leftVideo.currentTime).toBe(0.5);
      expect(rightVideo.currentTime).toBe(2.5);
      expect(point.value).toBe('');
      expect(leftPlay).toHaveBeenCalledTimes(1);
      expect(rightPlay).toHaveBeenCalledTimes(1);
      expect(leftPause).toHaveBeenCalledTimes(1);
      expect(rightPause).toHaveBeenCalledTimes(1);
      expect(w.eval('VM.filmProject().canon')).toBe(true);
      w.eval("A.set({path:'ws.film.tab',v:'review'})");
      await w.__settled();
      w.document.querySelector('[data-l="film-opinions"][data-k="opinion-old"]').click();
      await w.__settled();
      const compare = w.document.querySelector('[data-act="filmOpinionCompare"]');
      expect(compare?.textContent).toBe(w.eval("tc('films.compareResult')"));
      compare.click();
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith(
          'filmOpinionCompare',
          expect.objectContaining({ id: 'opinion-old', from: 'old', to: 'new' }),
          undefined,
        ),
      );
      const selection = {
        ...JSON.parse(right.dataset.pick).args,
        at: 2.5,
        x: 100,
        y: 100,
        width: 200,
        height: 100,
      };
      w.filmSelection = selection;
      w.filmSelectionElement = w.document.querySelector(`[data-media="${referenceId}"]`);
      w.eval('A.filmSelect(window.filmSelection, window.filmSelectionElement)');
      await w.__settled();
      expect(w.eval('CS.pop.film')).toEqual(selection);
      expect(w.document.querySelector(`[data-media="${primaryId}"] .media-marks rect`)).toBeNull();
      expect(w.document.querySelectorAll(`[data-media="${referenceId}"] .media-marks rect`)).toHaveLength(1);
      w.clowderChat.update();
      await w.__settled();
      expect(w.document.querySelectorAll(`[data-media="${referenceId}"] .media-marks rect`)).toHaveLength(1);
      expect(filmProject.media.marks).toEqual([]);
      expect(filmProject.comparison.marks).toEqual([]);
      await w.eval("A.cafeSel({v:'anno'})");
      expect(action).toHaveBeenCalledWith('filmMark', selection, undefined);
      expect(w.eval('CS.pop')).toBeNull();
      expect(w.eval('TOAST_LOG')).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('uses the r124 media and clip popup declarations, retaining a preview-only selection on its own media', async () => {
    const state = {
      clipPreview: null as unknown,
      film: { layout: 'list', tab: 'story', assets: {}, compare: '', opinion: null },
    };
    const film = contentRuntimeFilm('owner', 'screening');
    const { dom, w, ui, action, errors } = await boot(
      undefined,
      (data) => {
        data.messages[1].extra = {
          rich: {
            v: 1,
            blocks: [
              {
                v: 1,
                id: 'gallery-owner',
                kind: 'media_gallery',
                items: [{ url: '/uploads/owner.png', alt: 'Owner image' }],
              },
            ],
          },
        };
      },
      undefined,
      { workbenchState: state },
      undefined,
      {},
      { film },
    );
    try {
      await w.eval("A.mediaOpen({ mid:'reply-1',block:'gallery-owner',i:0})");
      await w.__settled();
      expect(ui.lb).toMatchObject({ mid: 'reply-1', block: 'gallery-owner', i: 0 });
      expect(
        w.document.querySelector('[data-pop="media"] img[src="https://api.test/uploads/owner.png"]'),
      ).not.toBeNull();
      w.document.querySelector('[data-pop="media"] [data-act="close"]').click();
      await w.__settled();
      expect(ui.lb).toBeNull();
      expect(w.document.querySelector('[data-pop="media"]')).toBeNull();
      state.clipPreview = {
        title: 'Owner film',
        sub: 'Frozen screening',
        url: 'https://api.test/screening.mp4',
        markArgs: { id: 'owner', screening: 'screening' },
        media: {
          id: 'film:owner:screening:preview',
          kind: 'video',
          src: 'https://api.test/screening.mp4',
          label: 'Frozen screening',
        },
      };
      w.clowderChat.update();
      await w.__settled();
      const preview = w.eval('VM.filmPreview()');
      const host = w.document.querySelector('[data-pop="clip.preview"]');
      expect(host.textContent).toContain('Old input');
      const media = host.querySelector('[data-media]');
      const selection = { ...JSON.parse(media.dataset.pick).args, at: 2.5, x: 10, y: 20, width: 30, height: 40 };
      w.previewSelection = selection;
      w.previewSelectionElement = media;
      w.eval('A.filmSelect(window.previewSelection, window.previewSelectionElement)');
      await w.__settled();
      expect(w.document.querySelectorAll('[data-pop="clip.preview"] .media-marks rect')).toHaveLength(1);
      expect(preview.media.marks).toEqual([]);
      await w.eval("A.cafeSel({v:'anno'})");
      expect(action).toHaveBeenCalledWith('filmMark', selection, undefined);
      state.clipPreview = null;
      w.clowderChat.update();
      await w.__settled();
      expect(w.document.querySelector('[data-pop="clip.preview"]')).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('offers rollback only for one source-current version with one parent while leaving history available', async () => {
    const owner = programFixture();
    owner.program.currentAssetVersionRefs = [assetRef('v2')];
    const review = assetReviewFixture('v3', 'v3');
    review.versions[2].parentEdges = [{ parentVersionRef: assetRef('v2'), edgeRef: ownerRef('v3-parent') }];
    const reading = { view: 'judge', stage: null, decision: '', notice: '' };
    const { dom, w, action, port } = await boot(undefined, undefined, undefined, () => ({
      workbenchState: { evoId: PROGRAM_ID, evoReading: { [PROGRAM_ID]: reading } },
      evolutionOwner: owner,
      evolutionCanDecide: false,
      evolutionProgress: { state: '', error: null },
      evolutionAssets: {
        catalog: review,
        selected: review.selected,
        selectedTitle: review.versions[2].title,
        diff: review.selected!.diff,
        versions: projectAssetVersions(owner, review).map((v) => ({
          ...v,
          title: review.versions.find((entry) => entry.versionRef.version === v.ref.version)?.title,
        })),
      },
      cafeWsEvo: { load: '', sections: { list: false }, active: [], done: [] },
    }));
    try {
      w.eval("ENGINE_PARTS.openTab('panel', 'evolution')");
      await w.eval(`A.wsSub({ k:'evolution',v:${JSON.stringify(PROGRAM_ID)}})`);
      await w.__settled();
      const read = () =>
        w.eval(
          "navWith(navTabKey('panel','evolution'), navTop(navTabKey('panel','evolution')), function () { return VM.cafeWsEvo().detail; })",
        );
      expect(read().use.currentTitles).toEqual([{ title: '补充边界示例', hasTitle: true }]);
      expect(JSON.parse(read().use.rollback.versionRef)).toEqual(assetRef('v2'));
      review.versions[2].parentEdges.push({ parentVersionRef: assetRef('v1'), edgeRef: ownerRef('v3-other-parent') });
      w.clowderChat.update(port);
      await w.__settled();
      expect(read().use.rollback).toBeNull();
      review.versions[2].parentEdges.pop();
      const otherRef = assetRef('v1', 'another-asset');
      review.currentVersionRefs.push(otherRef);
      review.versions.push({
        versionRef: otherRef,
        title: 'Other current asset',
        parentEdges: [{ parentVersionRef: assetRef('v0', 'another-asset'), edgeRef: ownerRef('other-parent') }],
      });
      w.clowderChat.update(port);
      await w.__settled();
      expect(read().use.rollback).toBeNull();
      reading.view = 'hist';
      w.clowderChat.update(port);
      await w.__settled();
      expect(read().hist.versions).toHaveLength(4);
      await w.eval(`A.evoVersion(${JSON.stringify(read().hist.versions[2])})`);
      expect(action).toHaveBeenCalledWith(
        'evolutionOpen',
        { id: PROGRAM_ID, versionRef: JSON.stringify(assetRef('v3')) },
        undefined,
      );
      expect(w.eval('TOAST_LOG')).toEqual([]);
    } finally {
      dom.window.close();
    }
  });
  it('renders owner adoption, actual use receipts and version history through the existing evolution declarations', async () => {
    const owner = programFixture();
    owner.program.currentAssetVersionRefs = [assetRef('v2')];
    const review = assetReviewFixture('v2');
    review.selected!.uses[0].ownerHref = '/thread/consumer-thread?messageId=consumer-mid';
    const reading = { view: 'judge', stage: null, decision: '', notice: '' };
    const { dom, w, action } = await boot(undefined, undefined, undefined, {
      workbenchState: { evoId: PROGRAM_ID, evoReading: { [PROGRAM_ID]: reading } },
      evolutionOwner: owner,
      evolutionCanDecide: false,
      evolutionProgress: { state: '', error: null },
      evolutionAssets: {
        catalog: review,
        selected: review.selected,
        selectedTitle: '补充边界示例',
        diff: review.selected!.diff,
        versions: projectAssetVersions(owner, review).map((v) => ({
          ...v,
          title: review.versions.find((entry) => entry.versionRef.version === v.ref.version)?.title,
        })),
      },
      cafeWsEvo: { load: '', sections: { list: false }, active: [], done: [] },
    });
    try {
      w.eval("ENGINE_PARTS.openTab('panel', 'evolution')");
      await w.eval(`A.wsSub({ k:'evolution',v:${JSON.stringify(PROGRAM_ID)}})`);
      await w.__settled();
      const detailRead =
        "navWith(navTabKey('panel','evolution'), navTop(navTabKey('panel','evolution')), function () { return VM.cafeWsEvo().detail; })";
      const detail = w.eval(detailRead);
      expect(detail.use.currentTitles).toEqual([{ title: '补充边界示例', hasTitle: true }]);
      expect(detail.use.receipts[0]).toMatchObject({
        linkKind: 'message',
        threadId: 'consumer-thread',
        messageId: 'consumer-mid',
      });
      w.document.querySelector('[data-view="cafe.ws.evolution"] [data-k="evo-use"]').click();
      await w.__settled();
      expect(w.document.querySelector('[data-view="cafe.ws.evolution"]')?.textContent).toContain('补充边界示例');
      expect(JSON.parse(detail.use.rollback.versionRef).version).toBe('v1');
      await w.eval(`A.evoVersion(${JSON.stringify(detail.use.rollback)})`);
      expect(action).toHaveBeenCalledWith(
        'evolutionOpen',
        { id: PROGRAM_ID, versionRef: JSON.stringify(assetRef('v1')) },
        undefined,
      );
      reading.view = 'hist';
      w.clowderChat.update();
      await w.__settled();
      const history = w.eval(detailRead).hist;
      expect(w.eval(detailRead).view).toBe('hist');
      expect(history.versions).toHaveLength(3);
      expect(w.document.querySelector('[data-view="cafe.ws.evolution"]')?.textContent).toContain('v2 的人话变化说明');
      await w.eval("A.msgJump({ t:'source-thread',mid:'source-mid'})");
      expect(action).toHaveBeenCalledWith(
        'jump',
        { t: 'source-thread', thread: 'source-thread', mid: 'source-mid' },
        undefined,
      );
      expect(w.eval('TOAST_LOG')).toEqual([]);
    } finally {
      dom.window.close();
    }
  });
  it('opens the verified recall source and its original reply through the r135 inline actions', async () => {
    const events = recallSourceRecords(
      [
        {
          id: 'recall-owner',
          catId: 'codex',
          messageId: 'reply-1',
          query: 'Owner query',
          timestamp: 1,
          results: [{ title: 'Owner profile', href: '/memory?family=profile&memoryId=corpus&revision=rev-owner' }],
        },
      ],
      [],
    );
    const bench = fixtureWorkbenchSource();
    const { dom, w, action } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      {},
      { workbench: { ...bench, recall: { ...bench.recall, events } } },
    );
    try {
      w.eval("ENGINE_PARTS.openTab('panel', 'recall')");
      await w.__settled();
      const view = w.document.querySelector('[data-view="cafe.ws.recall"]');
      view.querySelector('.lr-head').click();
      const source = view.querySelector('[data-act="memOpen"][data-family="profile"]');
      expect(source.dataset).toMatchObject({ family: 'profile', id: 'corpus', revision: 'rev-owner' });
      view.querySelector('[data-act="msgJump"][data-mid="reply-1"]').click();
      await w.__settled();
      expect(action).toHaveBeenCalledWith(
        'jump',
        expect.objectContaining({ mid: 'reply-1', t: 'pdl-test', thread: 'pdl-test' }),
        undefined,
      );
    } finally {
      dom.window.close();
    }
  });
  it('reprojects recall metadata after a settings-space visit when the held recall receipt changes', async () => {
    const data = fixtureData(),
      bench = fixtureWorkbenchSource();
    const events = recallSourceRecords(
      [
        {
          id: 'stored-recall',
          catId: 'codex',
          messageId: 'reply-1',
          query: 'Stored evidence',
          timestamp: data.messages[1].timestamp,
        },
      ],
      data.messages,
    );
    const read = {
      ...bench,
      recall: { threadId: data.threadId, load: '', page: { readStatus: 'ready', nextCursor: null }, events },
    };
    const { dom, w, port, errors, buildModels } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      (port) => {
        const original = port.action;
        port.action = async (name, args, el) =>
          name === 'membersRead'
            ? {
                accounts: [],
                templates: [],
                blank: initialState(),
                codex: {},
                strategies: [],
                runtimes: [],
                libraries: [],
                clients: [],
              }
            : original(name, args, el);
      },
      {},
      { workbench: read },
    );
    try {
      expect(w.document.querySelector('[data-mid="reply-1"] [data-act="recallOpen"]')).not.toBeNull();
      expect(() => w.eval('spaceOpen("settings")'), 'switch to settings').not.toThrow();
      await w.__settled();
      port.data.project = {
        workbench: { ...read, recall: { ...read.recall, load: 'loading', page: null, events: [] } },
      };
      w.clowderChat.update(port);
      expect(w.eval('chatRead("chatStream").items[1].meta')).toBeNull();
      expect(() => w.eval('spaceOpen("cafe")'), 'return to conversation').not.toThrow();
      await w.__settled();
      expect(w.document.querySelector('[data-mid="reply-1"] [data-act="recallOpen"]') === null).toBe(true);
      port.data.project = { workbench: read };
      w.clowderChat.update(port);
      await w.__settled();
      w.document.querySelector('[data-mid="reply-1"] [data-act="recallOpen"]').click();
      await w.__settled();
      expect(w.eval('S.ws.recallFor')).toBe('reply-1');
      expect(w.eval('S.ws.recallExpected')).toBe(1);
      expect(w.eval('VM.cafeWsRecall().groups[0].key')).toBe('reply-1');
      expect(errors).not.toHaveBeenCalled();
      expect(buildModels).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });
  it('filters one reply group, clears the filter and continues the r135 event cursor', async () => {
    const data = fixtureData();
    const older = { ...data.messages[1], extra: { stream: { turnInvocationId: 'older' } }, timestamp: 10 };
    const newer = { ...older, id: 'newer', timestamp: 20, extra: { stream: { turnInvocationId: 'newer' } } };
    older.toolEvents = ['older-call', 'second-older-call'].map((id, i) => ({
      id,
      type: 'tool_use',
      label: 'search_evidence',
      detail: JSON.stringify({ query: 'older evidence' }),
      timestamp: 12 + i,
      executionRef: 'older',
      toolUseId: id,
    }));
    newer.toolEvents = [
      {
        id: 'newer-call',
        type: 'tool_use',
        label: 'search_evidence',
        detail: JSON.stringify({ query: 'newer evidence' }),
        timestamp: 22,
        executionRef: 'newer',
        toolUseId: 'newer-call',
      },
    ];
    const events = recallSourceRecords(
      [
        { id: 'older-call', catId: 'codex', invocationId: 'older', query: 'older evidence', timestamp: 12 },
        { id: 'second-older-call', catId: 'codex', invocationId: 'older', query: 'more older evidence', timestamp: 13 },
        { id: 'newer-call', catId: 'codex', invocationId: 'newer', query: 'newer evidence', timestamp: 22 },
      ],
      [older, newer],
    );
    const groups = consoleValue('recallGroups(__events,__data)', { __events: events, __data: data }) as {
      key: string;
    }[];
    const state = { recallFor: null, recallExpected: 0 };
    const {
      dom,
      w,
      action,
      data: chatData,
      port,
    } = await boot(
      undefined,
      (chatData) => {
        chatData.messages = [chatData.messages[0], older, newer];
      },
      undefined,
      { workbenchState: state },
      undefined,
      {},
      {
        workbench: {
          ...fixtureWorkbenchSource(),
          recall: {
            threadId: data.threadId,
            load: '',
            page: { readStatus: 'ready', nextCursor: 'owner-event-cursor' },
            events,
          },
        },
      },
    );
    try {
      const recallButton = [...w.document.querySelectorAll('[data-mid="reply-1"] [data-act="recallOpen"]')].find(
        (button: Element) => button.textContent === w.eval("tc('wsRecall.summary.count',2)"),
      );
      expect(recallButton).toBeDefined();
      recallButton.click();
      await w.__settled();
      expect(state.recallFor).toBe('reply-1');
      expect(state.recallExpected).toBe(2);
      const view = w.document.querySelector('[data-view="cafe.ws.recall"]');
      expect(view.textContent).toContain('older evidence');
      expect(view.textContent).not.toContain('newer evidence');
      expect(w.eval('VM.cafeWsRecall().groups').map((group: { key: string }) => group.key)).toEqual(['reply-1']);
      expect(view.querySelector('[data-act="recallEventsMore"]')).toBeNull();
      view.querySelector('[data-act="set"][data-path="ws.recallFor"]').click();
      await w.__settled();
      expect(action).toHaveBeenCalledWith('recallBrowse', {}, undefined);
      expect(w.eval('VM.cafeWsRecall().groups').map((group: { key: string }) => group.key)).toEqual(
        groups.map((group) => group.key),
      );
      const olderButton = w.document.querySelector('[data-view="cafe.ws.recall"] [data-act="recallEventsMore"]');
      expect(olderButton).toBeDefined();
      olderButton.click();
      await w.__settled();
      expect(action).toHaveBeenCalledWith(
        'recallEventsMore',
        expect.objectContaining({ cursor: 'owner-event-cursor' }),
        undefined,
      );
      expect(w.eval('TOAST_LOG')).toEqual([]);
      chatData.threadId = 'another-thread';
      port.threadId = chatData.threadId;
      port.data = fixtureInput(chatData);
      port.sidebarData = fixtureSidebar(chatData);
      w.clowderChat.update(port);
      await w.__settled();
      expect(state.recallFor).toBeNull();
    } finally {
      dom.window.close();
    }
  });
  it('uses r118 engine errors for an API error envelope, deduplicates and notifies again after recovery', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ error: 'Owner unavailable' })));
    let result = await request('/api/owner').catch((error: Error) => error);
    const bench = fixtureWorkbenchSource();
    const { dom, w, errors } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      {},
      {
        workbench: {
          ...bench,
          tasks: [
            {
              id: 'healthy-task',
              title: 'Healthy owner task',
              kind: 'work',
              threadId: 'pdl-test',
              status: 'todo',
              createdAt: 1,
              updatedAt: 1,
              createdBy: 'user',
            },
          ],
        },
        readFailures: { terminal: result },
      },
    );
    try {
      w.eval("ENGINE_PARTS.openTab('panel', 'tasks')");
      await w.__settled();
      await vi.waitFor(() => expect(w.eval('TOAST_LOG.length')).toBe(1));
      expect(w.document.querySelector('textarea')).not.toBeNull();
      expect(w.document.body.textContent).toContain('Healthy owner task');
      expect(w.document.querySelector('.toast[data-tone="danger"]')?.textContent).toBe(
        w.eval("tc('common.dataError')"),
      );
      result = await request('/api/owner').catch((error: Error) => error);
      w.clowderChat.pushProject({ readFailures: { terminal: result } });
      await w.__settled();
      expect(w.eval('TOAST_LOG.length')).toBe(1);
      expect(errors).toHaveBeenCalledTimes(1);
      vi.mocked(apiFetch).mockImplementation(async () => new Response('{}'));
      result = await request('/api/owner');
      w.clowderChat.pushProject({ readFailures: {} });
      await w.__settled();
      vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ error: 'Owner unavailable' })));
      result = await request('/api/owner').catch((error: Error) => error);
      w.clowderChat.pushProject({ readFailures: { terminal: result } });
      await w.__settled();
      await vi.waitFor(() => expect(w.eval('TOAST_LOG.length')).toBe(2));
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      dom.window.close();
    }
  });
  it('isolates errors in r118 pdlView and sidebar VM reads without a host error boundary', async () => {
    const { dom, w, errors } = await boot();
    try {
      w.eval("VM.cafeWsOps = function () { throw new Error('ops projection'); }; ENGINE_PARTS.openTab('panel', 'ops')");
      await w.__settled();
      await vi.waitFor(() => expect(w.eval('TOAST_LOG.length')).toBe(1));
      expect(w.document.querySelector('textarea')).not.toBeNull();
      w.eval("VM.cafeNavShell = function () { throw new Error('sidebar projection'); }; render(true)");
      await w.__settled();
      await vi.waitFor(() => expect(w.eval('TOAST_LOG.length')).toBe(2));
      expect(w.document.querySelector('textarea')).not.toBeNull();
      expect(errors).toHaveBeenCalled();
      w.clowderChat.update();
      await w.__settled();
      expect(w.eval('TOAST_LOG.length')).toBe(2);
    } finally {
      dom.window.close();
    }
  });
  it('opens a live child trajectory through the declared run opener and the existing execution view', async () => {
    const bench = fixtureWorkbenchSource();
    const source = {
      ...bench,
      execution: {
        ...bench.execution,
        detail: {
          invocationId: 'child-owner',
          summary: {
            catId: 'codex',
            keyMessages: ['Exact live child'],
            sessionSeq: 0,
            startedAt: 1,
            status: 'running',
          },
          events: [],
          timelineRows: [],
        },
      },
    };
    const { dom, w, action } = await boot(
      undefined,
      undefined,
      undefined,
      {
        workbenchState: { tjMode: 'timeline' },
      },
      undefined,
      {},
      { workbench: source },
    );
    try {
      await w.eval("A.runOpen({ k:'child-owner'})");
      await w.__settled();
      expect(action).toHaveBeenCalledWith('execOpen', { k: 'exec', v: 'child-owner' }, undefined);
      expect(w.document.querySelector('[data-view="ws.exec"]')?.textContent).toContain('Exact live child');
      expect(w.eval('TOAST_LOG')).toEqual([]);
    } finally {
      dom.window.close();
    }
  });
  it('retains the existing owner read-error component once without adding a toast', async () => {
    const { dom, w, action } = await boot(undefined, undefined, undefined, {
      cafeWsOps: { load: 'error' },
    });
    try {
      w.eval("ENGINE_PARTS.openTab('panel', 'ops')");
      await w.__settled();
      const error = w.eval("tc('wsOps.load.error')");
      expect(w.document.querySelector('[data-view="cafe.ws.ops"]')?.textContent).toContain(error);
      const failure = new Error('Owner unavailable');
      failure.name = 'PdlReadError';
      action.mockRejectedValueOnce(failure);
      w.document.querySelector('[data-act="viewRetry"]').click();
      await vi.waitFor(() => expect(action).toHaveBeenCalledWith('refresh', { k: 'ops' }, undefined));
      w.clowderChat.update();
      await w.__settled();
      expect(w.eval('TOAST_LOG')).toEqual([]);
      expect(w.document.querySelectorAll('[data-view="cafe.ws.ops"]')).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });
  it.each([
    'home',
    'ops',
    'replay',
    'evolution',
  ])('keeps the shell and other owner data when the %s binding is absent, with one danger toast', async (panel) => {
    const failure = new Error('projection failure');
    const { dom, w } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      {},
      {
        workbench: {
          ...fixtureWorkbenchSource(),
          tasks: [
            {
              id: 'healthy-task',
              title: 'Healthy owner task',
              kind: 'work',
              threadId: 'pdl-test',
              status: 'todo',
              createdAt: 1,
              updatedAt: 1,
              createdBy: 'user',
            },
          ],
        },
        readFailures: { [panel]: failure },
      },
    );
    try {
      w.eval(`ENGINE_PARTS.openTab('panel', '${panel}')`);
      await w.__settled();
      await vi.waitFor(() => expect(w.eval('TOAST_LOG.length')).toBe(1));
      expect(w.document.querySelector('.toast[data-tone="danger"]')?.textContent).toBe(
        w.eval("tc('common.dataError')"),
      );
      expect(w.document.querySelector('textarea')).not.toBeNull();
      expect(w.document.body.textContent).not.toContain('Application error');
      w.eval("ENGINE_PARTS.openTab('panel', 'tasks')");
      await w.__settled();
      expect(w.document.body.textContent).toContain('Healthy owner task');
      w.clowderChat.pushProject({ readFailures: { [panel]: failure } });
      await w.__settled();
      expect(w.eval('TOAST_LOG.length')).toBe(1);
      w.clowderChat.pushProject({ readFailures: {} });
      await w.__settled();
      w.clowderChat.pushProject({ readFailures: { [panel]: failure } });
      await w.__settled();
      await vi.waitFor(() => expect(w.eval('TOAST_LOG.length')).toBe(2));
    } finally {
      dom.window.close();
    }
  });
  it('does not show the history marker or load-older action for a new empty thread (r116)', async () => {
    const { dom, w } = await boot(undefined, (data) => {
      data.messages = [];
      data.hasMore = false;
    });
    try {
      expect(w.document.body.textContent).not.toContain('已到最早');
      expect(w.document.querySelector('[data-act="streamOlder"]')).toBeNull();
      expect(w.document.querySelector('textarea')).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });
  it('opens the existing all-works page with its global owner and reuses the current work controls', async () => {
    const reading = { page: false, q: '', f: 'all', view: 'list', scope: 'thread', group: 'none', cat: '' };
    const reviews = contentRuntimeReviews();
    reviews.global.works[0].navigationId = 'global-work';
    reviews.global.works[0].name = 'Global owner work';
    const { dom, w, action } = await boot(
      undefined,
      undefined,
      undefined,
      { worksState: reading },
      undefined,
      {},
      { reviews: { ...reviews, openedWork: null } },
    );
    try {
      action.mockImplementation((name: string, args: Record<string, string>) => {
        if (name === 'worksPage') reading.page = args.v === 'true';
      });
      w.eval('go("works");render(true)');
      await vi.waitFor(() => expect(action).toHaveBeenCalledWith('worksPage', { v: 'true' }, undefined));
      await w.__settled();
      expect(w.document.body.textContent).toContain('Global owner work');
      const target = w.document.querySelector('[data-act="workOpen"][data-id="global-work"]');
      expect(target).not.toBeNull();
      target.click();
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith('workOpen', expect.objectContaining({ id: 'global-work' }), undefined),
      );
    } finally {
      dom.window.close();
    }
  });
  it('binds r115 runtime identity and real evolution detail through the copied declarations', async () => {
    const owner = programFixture('deciding');
    const state = {
      evoId: PROGRAM_ID,
      evoReading: { [PROGRAM_ID]: { view: 'judge', stage: null, decision: '', notice: '' } },
    };
    const project = {
      workbenchState: state,
      evolutionOwner: owner,
      evolutionCanDecide: false,
      evolutionProgress: { state: '', error: '' },
      cafeWsEvo: { load: '', sections: { list: false }, active: [], done: [] },
      cafeWsOps: {
        load: '',
        cur: 'rt',
        sections: [],
        facts: { rtEvents: 1 },
        rt: {
          d: {
            id: 'runtime-opened-owner',
            member: { name: 'Owner member' },
            model: 'Owner model',
            bind: 'Owner thread',
            view: 'chat',
            tabs: [],
            rows: [{ title: 'Owner event' }],
            page: '1',
            first: true,
            last: true,
          },
        },
      },
    };
    const { dom, w, action } = await boot(undefined, undefined, undefined, project);
    try {
      const host = w.document.createElement('div');
      w.document.body.append(host);
      host.innerHTML = runInContext("pdlView('cafe.ws.ops')", dom.getInternalVMContext());
      expect(host.textContent).toContain('runtime-opened-owner');
      expect(host.textContent).toContain('Owner member');
      expect(host.textContent).toContain('Owner model');
      expect(host.textContent).toContain('Owner thread');
      expect(host.textContent).not.toContain('rt_9a01');
      w.eval("A.pick({ path: 'ws.gov', id: 'docs' })");
      await vi.waitFor(() => expect(action).toHaveBeenCalledWith('opsGovSelection', {}, undefined));
      w.eval(
        `ENGINE_PARTS.openTab('panel','evolution'); navOpen({ f: navTop(navTabKey('panel','evolution')).f, a: { sub: ${JSON.stringify(PROGRAM_ID)} }, into: navTabKey('panel','evolution'), push: true }); render(true)`,
      );
      await w.__settled();
      const view = w.document.querySelector('[data-view="cafe.ws.evolution"]');
      expect(view?.textContent).toContain(owner.program.displayName);
      expect(view?.textContent).not.toContain('t:');
      state.evoReading[PROGRAM_ID].view = 'hist';
      w.eval('render(true)');
      await w.__settled();
      expect(w.eval('VM.cafeWsEvo().detail.hist.rounds[0]')).toMatchObject({ cycle: 1 });
      expect(w.document.querySelector('[data-view="cafe.ws.evolution"]')?.textContent).toContain('第 1 轮');
    } finally {
      dom.window.close();
    }
  });

  it('uses the r114 report collection and actual telemetry condition without sample facts', async () => {
    const detail = {
      id: 'article-owner',
      title: 'Owner article',
      body: 'Owner body',
      reports: [] as { title: string; sub: string }[],
    };
    const obs = {
      views: [],
      stats: [],
      secs: [],
      cfg: [{ name: 'OWNER_CONFIG', value: 'Owner configuration', set: true, description: '' }],
      telemetryOff: false,
    };
    const { dom, w, port } = await boot(undefined, undefined, undefined, {
      workbenchState: { sigDetail: null },
      cafeWsSignals: { detail },
      cafeWsOps: { cur: 'obs', sections: [], obs },
    });
    try {
      const host = w.document.createElement('div');
      w.document.body.append(host);
      host.innerHTML = runInContext("pdlView('signal.article')", dom.getInternalVMContext());
      const title = runInContext("tc('wsSignals.report')", dom.getInternalVMContext());
      expect(host.textContent).not.toContain(title);
      expect(host.textContent).not.toContain('rpt_2b81');
      detail.reports = [{ title: 'Owner research report', sub: 'ready · 2026-11-03' }];
      w.clowderChat.update(port);
      await w.__settled();
      host.innerHTML = runInContext("pdlView('signal.article')", dom.getInternalVMContext());
      expect(host.textContent).toContain('Owner research report');
      host.innerHTML = runInContext("pdlView('cafe.ws.ops')", dom.getInternalVMContext());
      host.querySelector('[data-k="obs-cfg"]').click();
      host.innerHTML = runInContext("pdlView('cafe.ws.ops')", dom.getInternalVMContext());
      expect(host.textContent).toContain('Owner configuration');
      expect(host.querySelector('.notice')).toBeNull();
      obs.telemetryOff = true;
      w.clowderChat.update(port);
      await w.__settled();
      host.innerHTML = runInContext("pdlView('cafe.ws.ops')", dom.getInternalVMContext());
      expect(host.textContent).toContain(w.eval("tc('wsOps.telemetryOff')"));
    } finally {
      dom.window.close();
    }
  });

  it('mounts the r114 preview frame and forwards only its own raw message source to the application', async () => {
    const { dom, w, action } = await boot(
      undefined,
      undefined,
      undefined,
      {
        previewState: {
          tabs: [{ id: 'preview-owner', port: '3011', path: '/owner' }],
          console: [],
          active: 'preview-owner',
          consoleOpen: false,
          filter: 'all',
          warn: '',
        },
      },
      undefined,
      {},
      {
        preview: {
          gateway: { load: '', port: 4100 },
          discovered: { load: '', services: [] },
          health: { key: 'pdl-test:3011', reachable: true },
          pending: null,
          hmr: 'connected',
          receipt: null,
          console: [],
          warn: '',
          pendingAuto: null,
          target: undefined,
          src: 'https://preview.test/owner',
          ready: true,
          capturing: false,
          threadId: 'pdl-test',
        },
      },
    );
    try {
      runInContext("ENGINE_PARTS.openTab('panel','preview')", dom.getInternalVMContext());
      await w.__settled();
      const frame = w.document.querySelector('iframe[data-frame-on-message="pvFrameMessage"]');
      expect(frame.src).toBe('https://preview.test/owner');
      expect(frame.hasAttribute('srcdoc')).toBe(false);
      expect(frame.dataset.frameKey).toBe('preview');
      const post = vi.spyOn(frame.contentWindow, 'postMessage').mockImplementation(() => {});
      for (const [v, op] of [
        ['back', 'back'],
        ['fwd', 'forward'],
        ['reload', 'reload'],
      ]) {
        const button = w.document.querySelector(`[data-act="pvNav"][data-v="${v}"]`);
        expect(button).not.toBeNull();
        button.click();
        await vi.waitFor(() =>
          expect(post).toHaveBeenLastCalledWith(
            {
              source: 'cat-cafe-preview',
              type: 'navigate',
              op,
            },
            '*',
          ),
        );
      }
      expect(post).toHaveBeenCalledTimes(3);
      w.eval('render(true)');
      await w.__settled();
      expect(w.document.querySelector('iframe[data-frame-key="preview"]')).toBe(frame);
      frame.dispatchEvent(new w.Event('load'));
      expect(frame.src).toBe('https://preview.test/owner');
      expect(post).toHaveBeenCalledTimes(3);
      const mounted = action.mock.calls.find((c) => c[0] === 'previewFrame');
      expect(mounted?.[1]).toEqual({});
      expect(mounted?.[2] === frame).toBe(true);
      action.mockClear();
      const data = { source: 'cat-cafe-bridge', type: 'console', level: 'log', args: ['Owner frame'], timestamp: 1 };
      w.dispatchEvent(new w.MessageEvent('message', { data, origin: 'https://preview.test', source: w }));
      await Promise.resolve();
      expect(action.mock.calls.some((c) => c[0] === 'pvFrameMessage')).toBe(false);
      const event = new w.MessageEvent('message', {
        data,
        origin: 'https://preview.test',
        source: frame.contentWindow,
      });
      w.dispatchEvent(event);
      await vi.waitFor(() =>
        expect(action.mock.calls.some((c) => c[0] === 'pvFrameMessage' && c[1].event === event && c[2] === frame)).toBe(
          true,
        ),
      );
    } finally {
      dom.window.close();
    }
  });
  it('passes raw ANSI output through the copied terminal io to the platform and returns control input without replacing its screen', async () => {
    const bench = fixtureWorkbenchSource(),
      terminalSource = fixtureTerminalSource();
    bench.workspace.worktreeId = 'wt';
    const { dom, w, action, terminals } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      {},
      {
        workbench: bench,
        terminal: terminalSource,
      },
    );
    try {
      runInContext("ENGINE_PARTS.openTab('panel','terminal')", dom.getInternalVMContext());
      await new Promise((resolve) => setTimeout(resolve, 0));
      const screen = w.document.querySelector('[data-terminal="pty-real"]');
      expect(screen).not.toBeNull();
      terminalSource.mine.output += '\u001b[31';
      w.clowderChat.emit('terminal:output', { id: 'pty-real', data: '\u001b[31' });
      terminalSource.mine.output += 'mprogress\rOK\u001b[K';
      w.clowderChat.emit('terminal:output', { id: 'pty-real', data: 'mprogress\rOK\u001b[K' });
      const terminal = terminals.get('pty-real')!;
      expect(terminal.write.mock.calls.slice(-2)).toEqual([['\u001b[31'], ['mprogress\rOK\u001b[K']]);
      terminal.data!('\u0003');
      terminal.resize!({ cols: 100, rows: 30 });
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith('terminal:resize', { id: 'pty-real', cols: 100, rows: 30 }),
      );
      await vi.waitFor(() =>
        expect(
          action.mock.calls.some(
            ([name, args]) => name === 'terminal:input' && args.id === 'pty-real' && args.data === '\u0003',
          ),
        ).toBe(true),
      );
      expect(w.document.querySelector('[data-terminal="pty-real"]')).toBe(screen);
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('closes the task dialog while its owner works and reopens it with the draft on failure', async () => {
    const { dom, w, action } = await boot();
    let done!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      done = resolve;
    });
    action.mockImplementation((name) => (name === 'taskCreate' ? pending : undefined));
    try {
      runInContext("A.dialog({kind:'task'})", dom.getInternalVMContext());
      w.document.getElementById('dlg-in').value = 'Owner task';
      w.document
        .querySelector('[data-form="dialog"]')
        .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      expect(w.eval('S.dialog')).toBeNull();
      done(false);
      await pending;
      await vi.waitFor(() => expect(w.document.querySelector('[data-form="dialog"]')).not.toBeNull());
      expect(w.document.getElementById('dlg-in').value).toBe('Owner task');
    } finally {
      done(false);
      await pending;
      await w.__settled();
      dom.window.close();
    }
  });

  it('closes entity removal confirmation while the real terminal owner is pending', async () => {
    const bench = fixtureWorkbenchSource();
    bench.workspace.worktreeId = 'wt';
    const { dom, w, action } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      {},
      {
        workbench: bench,
        terminal: fixtureTerminalSource(),
      },
    );
    let done!: () => void;
    const pending = new Promise<void>((resolve) => {
      done = resolve;
    });
    action.mockImplementation((name) => (name === 'terminal:close' ? pending : undefined));
    try {
      const host = w.document.createElement('div');
      host.innerHTML = runInContext("pdlView('ws.terminal')", dom.getInternalVMContext());
      w.document.body.append(host);
      host.querySelector('[data-act="remove"][data-entity="term"]').click();
      w.document
        .querySelector('[data-form="dialog"]')
        .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      expect(w.eval('S.dialog')).toBeNull();
    } finally {
      done();
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 0));
      await w.__settled();
      dom.window.close();
    }
  });

  it('renders real source controls and reuses chat messages for the workbench replay player', async () => {
    const state = { sigView: 'sources', sigSel: {}, teamSub: null };
    const replayData = fixtureData();
    const replayEvents = replayData.messages.map((message, index) => ({
      index,
      eventNo: index,
      timestamp: message.timestamp,
      type: 'message',
      role: message.type,
      catId: message.catId,
      content: message.content,
    }));
    const { dom, w, data, action } = await boot(
      undefined,
      (data) => {
        data.threads[0].title = 'Owner replay';
      },
      undefined,
      {
        workbenchState: state,
        signalArticles: [],
        signalSources: [{ id: 'source-owner', enabled: true }],
        cafeWsSignals: {
          load: '',
          views: [],
          sources: {
            fetchRes: {
              newArticles: 2,
              fetchedArticles: 3,
              duplicateArticles: 1,
              errors: [{ source: 'source-owner', message: 'Owner fetch error' }],
            },
            groups: [
              {
                tier: 1,
                rows: [
                  {
                    id: 'source-owner',
                    name: 'Owner research feed',
                    enabled: true,
                    type: 'rss',
                    url: 'https://owner.test/feed',
                    lastFetchedAt: null,
                    tags: [],
                  },
                ],
              },
            ],
          },
        },
      },
      undefined,
      {},
      {
        replay: {
          thread: replayData.threadId,
          source: 'thread',
          load: '',
          events: replayEvents,
          engine: {
            state: 'idle',
            speed: 100,
            currentIndex: 1,
            totalEvents: replayEvents.length,
            elapsedMs: 1000,
            totalDurationMs: 1000,
            displayMode: 'cinematic',
            adaptivePacing: true,
            bulletTime: null,
          },
          typingMs: null,
          guideLanguage: 'zh',
          guideScript: [],
          guideHtml: '',
          guideTeam: {},
          messages: replayData.messages,
          chapters: [],
          features: [],
        },
      },
    );
    try {
      const host = w.document.createElement('div');
      w.document.body.append(host);
      host.innerHTML = runInContext("pdlView('cafe.ws.signals')", dom.getInternalVMContext());
      expect(host.textContent).toContain('Owner research feed');
      expect(host.textContent).toContain(w.eval("tc('signals.fetchSummary',2,3,1)"));
      expect(host.textContent).toContain('Owner fetch error');
      host.querySelector('[data-entity="src"]').click();
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith('signalSourceStatus', { id: 'source-owner', enabled: false }, undefined),
      );
      host.innerHTML = runInContext("pdlView('ws.replay')", dom.getInternalVMContext());
      expect(
        [...host.querySelectorAll('[data-stream="theater"] > .cafe-m[data-mid]')].map(
          (e: HTMLElement) => e.dataset.mid,
        ),
      ).toEqual(data.messages.map((m) => m.id));
      host.querySelector('[data-act="rpPlay"]').click();
      await vi.waitFor(() => expect(action).toHaveBeenCalledWith('rpPlay', {}, undefined));
      host.remove();
      await w.eval("A.theater({ id:'pdl-test'})");
      await w.__settled();
      const theater = w.document.querySelector('[data-pop="theater"]');
      expect(theater.textContent).toContain('Owner replay');
      expect(
        [...theater.querySelectorAll('[data-stream="theater"] > .cafe-m[data-mid]')].map(
          (m: HTMLElement) => m.dataset.mid,
        ),
      ).toEqual(data.messages.map((m) => m.id));
      expect(w.eval('POPUPS.theater')).toBeUndefined();
      theater.querySelector('[data-act="close"]').click();
      await w.__settled();
      expect(w.document.querySelector('[data-pop="theater"]')).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('retains the file rename draft and owner rejection in the native entity dialog', async () => {
    const { dom, w, action } = await boot();
    action.mockImplementation((name) =>
      name === 'fileRename' ? Promise.reject(new Error('owner revision conflict')) : undefined,
    );
    try {
      runInContext("A.rename({ entity:'path', id:'src/original.ts' })", dom.getInternalVMContext());
      const input = w.document.querySelector('#dlg-in');
      input.value = 'renamed.ts';
      w.document
        .querySelector('[data-form="dialog"]')
        .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await w.__settled();
      expect(action).toHaveBeenCalledWith('fileRename', { path: 'src/original.ts', v: 'renamed.ts' });
      expect(w.document.querySelector('[data-form="dialog"]').textContent).toContain('owner revision conflict');
      expect(w.document.querySelector('#dlg-in').value).toBe('renamed.ts');
    } finally {
      dom.window.close();
    }
  });

  it('opens and leaves Team details through the native workbench stack', async () => {
    const state = { teamSub: null as string | null, teamByThread: {}, teamV: 'roster' };
    const model = structuredClone(teamModel);
    model.resolution.snapshot.candidates[0].binding.catId = 'codex';
    model.resolution.snapshot.candidates[0].profile.revision.catId = 'codex';
    model.resolution.snapshot.candidates[0].profile.revision.relevantSignals[0].summary = 'Owner applied profile';
    const { dom, w } = await boot(undefined, undefined, undefined, { workbenchState: state }, (port) => {
      Object.assign(port, {
        data: {
          ...fixtureInput(fixtureData()),
          project: { ...ownerData(), team: { value: model, loading: false, error: null } },
        },
      });
    });
    try {
      runInContext("ENGINE_PARTS.openTab('panel','team')", dom.getInternalVMContext());
      w.document.querySelector('[data-act="wsSub"][data-k="team"]').click();
      await w.__settled();
      expect(state.teamSub).toBe('m:codex');
      expect(w.document.body.textContent).toContain('Owner applied profile');
      expect(w.document.body.textContent).not.toContain('t:');
      w.document.querySelector('[data-act="back"][data-c="panel/team"]').click();
      await w.__settled();
      expect(state.teamSub).toBeNull();
      const restored = w.document.querySelector('[data-view="cafe.ws.team"]').textContent;
      expect(restored).toContain(w.eval('VM.cafeWsTeam().roster.items[0].name'));
      expect(w.eval('VM.cafeWsTeam().roster.items[0].good')).toBe('Owner applied profile');
      expect(w.eval('VM.cafeWsTeam().detail')).toBeUndefined();
    } finally {
      dom.window.close();
    }
  });

  it('retains terminal deletion confirmation and the exact owner rejection', async () => {
    const bench = fixtureWorkbenchSource();
    bench.workspace.worktreeId = 'wt';
    const { dom, w, action } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      {},
      {
        workbench: bench,
        terminal: fixtureTerminalSource('pty-owner'),
      },
    );
    action.mockImplementation((name) =>
      name === 'terminal:close' ? Promise.reject(new Error('PTY owner busy')) : undefined,
    );
    try {
      const host = w.document.createElement('div');
      host.innerHTML = runInContext("pdlView('ws.terminal')", dom.getInternalVMContext());
      w.document.body.append(host);
      host.querySelector('[data-act="remove"][data-entity="term"]').click();
      w.document
        .querySelector('[data-form="dialog"]')
        .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await w.__settled();
      expect(w.document.querySelector('[data-form="dialog"]').textContent).toContain('PTY owner busy');
    } finally {
      dom.window.close();
    }
  });

  it('paints the entire shell and chat from the copied theme, including rich-body platform calls', async () => {
    const { dom, w, port } = await boot();
    try {
      expect(w.document.querySelector('.rail')).not.toBeNull();
      expect(w.document.querySelector('.nav')).not.toBeNull();
      expect(w.document.querySelector('#stream')).not.toBeNull();
      expect(w.document.querySelectorAll('#stream [data-stream] > .cafe-m[data-mid]').length).toBe(2);
      expect(w.document.querySelector('#chat-input')).not.toBeNull();
      await vi.waitFor(() => expect(port.richRender).toHaveBeenCalledWith('math', 'x^2+y^2=z^2', false));
      await vi.waitFor(() => expect(w.document.querySelector('.md-rich[data-done]')).not.toBeNull());
      expect(w.document.body.textContent).not.toContain('t:');
    } finally {
      dom.window.close();
    }
  });

  it('uses the full-window export frame, exact mids and the same readonly message nodes', async () => {
    const { dom, w } = await boot(['reply-1']);
    try {
      const frame = w.document.querySelector('[data-view="thread.export"]');
      expect(frame).not.toBeNull();
      expect(
        [...frame.querySelectorAll('[data-stream="export"] > [data-mid]')].map((e: HTMLElement) => e.dataset.mid),
      ).toEqual(['reply-1']);
      expect(frame.querySelectorAll('#chat-input, .cafe-acts').length).toBe(0);
      expect(w.location.hash).toBe('#export-pdl-test');
      expect(runInContext("navStack('window').map(function(x){return x.f;})", dom.getInternalVMContext())).toEqual([
        'node:thread.export',
      ]);
    } finally {
      dom.window.close();
    }
  });

  it('preserves the typed work reference through the actual copied canon button', async () => {
    const reference = { contentRef: 'work-one', ownerRevision: 3 };
    const { dom, w, action } = await boot(
      undefined,
      (_data, ui) => {
        ui.lb = { mid: '', block: '', i: 0 };
      },
      undefined,
      {},
      undefined,
      {},
      { reviews: contentRuntimeReviews() },
    );
    try {
      const host = w.document.createElement('div');
      host.innerHTML = runInContext("pdlView('work.body')", dom.getInternalVMContext());
      w.document.body.append(host);
      const button = host.querySelector('[data-act="assetCanonRead"]');
      expect(button).not.toBeNull();
      button.click();
      await vi.waitFor(() => expect(action.mock.calls.some((args) => args[0] === 'assetCanonRead')).toBe(true));
      expect(action.mock.calls.find((args) => args[0] === 'assetCanonRead')?.[1].reference).toEqual(reference);
    } finally {
      dom.window.close();
    }
  });

  it('preserves the contracted annotationId through the actual copied review judgment button', async () => {
    const view = structuredClone(artworkReviewFixture);
    const original = view.review.rounds[0];
    original.annotations = [
      {
        id: 'annotation-one',
        body: 'Original annotation',
        state: 'open',
        author: { kind: 'human', actorId: 'operator' },
        anchor: { kind: 'image-region', x: 1, y: 1, width: 5, height: 5 },
        createdAt: original.openedAt,
        updatedAt: original.openedAt,
        replies: [],
      },
    ];
    original.state = 'superseded';
    view.review.revision = 2;
    view.review.rounds.push({
      ...original,
      number: 2,
      state: 'awaiting_human',
      asset: { ...original.asset, ownerRevision: 2 },
      annotations: [],
      responses: [{ annotationId: 'annotation-one', disposition: 'addressed', explanation: 'Owner result' }],
      responseSource: { round: 1, ownerRevision: 1, reviewRevision: 1 },
    });
    const { dom, w, action } = await boot(
      undefined,
      (_data, ui) => {
        ui.review = { work: 'work-one', round: 2, draft: null, edit: null, compare: null, markup: null };
      },
      undefined,
      {},
      undefined,
      {},
      { reviews: contentRuntimeReviews(view) },
    );
    try {
      const host = w.document.createElement('div');
      host.innerHTML = runInContext("pdlView('media.review')", dom.getInternalVMContext());
      w.document.body.append(host);
      const button = host.querySelector('[data-act="reviewJudge"]');
      expect(button).not.toBeNull();
      button.click();
      await vi.waitFor(() => expect(action.mock.calls.some((args) => args[0] === 'reviewJudge')).toBe(true));
      expect(action.mock.calls.find((args) => args[0] === 'reviewJudge')?.[1].annotationId).toBe('annotation-one');
    } finally {
      dom.window.close();
    }
  });

  it('settles only after an asynchronous rich-body render is complete (r111 contract)', async () => {
    let resolve!: (html: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    const { dom, w } = await boot(['reply-1'], undefined, () => pending);
    try {
      let settled = false;
      const ready = w.__settled().then(() => {
        settled = true;
      });
      await new Promise((done) => setTimeout(done, 80));
      expect(settled).toBe(false);
      resolve('<math><mi>x</mi></math>');
      await ready;
      expect(w.document.querySelector('[data-view="thread.export"] .md-rich[data-done]')).not.toBeNull();
    } finally {
      resolve('<math><mi>x</mi></math>');
      await pending;
      await new Promise((done) => setTimeout(done, 0));
      dom.window.close();
    }
  });

  it('renders rich card body, user attachments, sandbox widgets and multi-choice coordinates from r111', async () => {
    const { dom, w } = await boot(undefined, (data, ui) => {
      data.messages[0].contentBlocks = [
        { type: 'image', url: '/uploads/example.png', alt: '附件图片' },
        { type: 'file', url: '/uploads/report.pdf', fileName: 'report.pdf', mimeType: 'application/pdf', fileSize: 12 },
      ];
      data.messages[1].extra = {
        rich: {
          v: 1,
          blocks: [
            {
              id: 'body',
              v: 1,
              kind: 'card',
              title: '富卡',
              bodyMarkdown: '**卡片正文**',
              fields: [{ label: '字段', value: '值' }],
            },
            { id: 'widget', v: 1, kind: 'html_widget', title: '嵌入', html: '<p>widget</p>' },
            {
              id: 'choice',
              v: 1,
              kind: 'interactive',
              interactiveType: 'multi-select',
              options: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
              ],
            },
          ],
        },
      };
      ui.multi = true;
      ui.picked['reply-1'] = { text: false, blocks: { body: true } };
    });
    try {
      const user = w.document.querySelector('[data-stream] > [data-mid="user-1"]');
      expect(user.querySelector('img[src="https://api.test/uploads/example.png"]')).not.toBeNull();
      expect(user.textContent).toContain('report.pdf');
      const reply = w.document.querySelector('[data-stream] > [data-mid="reply-1"]');
      expect(reply.textContent).toContain('消息已接入');
      expect(reply.textContent).toContain('卡片正文');
      expect(reply.textContent).toContain('字段');
      const frame = reply.querySelector('iframe');
      expect(frame.getAttribute('srcdoc')).toContain('widget');
      expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
      const choices = [...reply.querySelectorAll('[data-act="richPick"]')];
      expect(choices).toHaveLength(2);
      expect(choices[0].dataset).toMatchObject({ mid: 'reply-1', b: 'choice', v: 'a' });
      expect(reply.querySelector('[data-act="richRandom"]')).toBeNull();
      expect(reply.querySelector('[data-act="cafePick"][data-b="body"]')).not.toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('sends input through the registered action without replacing the active textarea', async () => {
    const { dom, w, data, action } = await boot();
    try {
      const input = w.document.getElementById('chat-input');
      input.focus();
      input.value = '真实输入';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(action).toHaveBeenCalledWith('compose', { v: '真实输入', pos: '4' }));
      data.input = '真实输入';
      w.clowderChat.update();
      expect(w.document.getElementById('chat-input')).toBe(input);
      input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.waitFor(() => expect(action.mock.calls.some((args) => args[0] === 'send')).toBe(true));
    } finally {
      dom.window.close();
    }
  });

  it('binds export filtering and file-context input through the existing VM and popup declarations', async () => {
    const { dom, w, data, ui, action, push } = await boot();
    try {
      const items = runInContext(
        "S.exportMids = ['reply-1']; VM.threadExport().items.map(function(x){ return x.mid; })",
        dom.getInternalVMContext(),
      );
      expect(Array.from(items)).toEqual(['reply-1']);
      data.contextSearch = { query: '', files: [], worktreeId: 'owner-worktree' };
      ui.pop = { kind: 'ctx' };
      push();
      await w.__settled();
      const input = w.document.getElementById('ctx-q');
      input.value = 'README';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(action).toHaveBeenCalledWith('contextSearch', { q: 'README' }, undefined));
      data.contextSearch = { query: 'README', files: [{ path: 'docs/README.md' }], worktreeId: 'owner-worktree' };
      push();
      await w.__settled();
      const contextFile = w.eval('VM.chatPop().contexts.find(x=>x.path==="docs/README.md")');
      const file = w.document.querySelector('[data-act="cafeTypedPick"][data-i="' + contextFile.index + '"]');
      expect(w.eval('VM.chatPop().contexts[Number(' + file.dataset.i + ')].path')).toBe('docs/README.md');
    } finally {
      dom.window.close();
    }
  });

  it('requires an explicit receiver and forwards canonical message ids through the existing modal row control', async () => {
    const { dom, w, data, ui, action, push } = await boot();
    try {
      expect(w.eval("POPUPS['chat.modal']")).toBeUndefined();
      expect(w.eval("PDL_POPUPS['chat.modal'].view")).toBe('chat.modal');
      expect(w.eval("PDL_POPUPS['chat.modal'].when")).toBe('cs.modal');
      data.threads.push({ ...data.threads[0], id: 'target-thread', title: '接收对话' });
      ui.picked['reply-1'] = { text: true, blocks: {} };
      push();
      runInContext("A.modal({v:'forward',id:'multi'})", dom.getInternalVMContext());
      expect(w.document.querySelector('[data-pop="chat.modal"] .dialog-body')?.textContent).toContain('接收对话');
      expect(w.document.querySelector('form[data-form="cafeModal"] button[type="submit"]').disabled).toBe(true);
      const row = w.document.querySelector('[data-path="cs.modal.to"][data-v="target-thread"]');
      row.click();
      expect(ui.modal?.cats).toEqual(['codex']);
      expect(w.document.querySelector('#forward-cats')).toBeNull();
      w.document
        .querySelector('form[data-form="cafeModal"]')
        .dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await vi.waitFor(() =>
        expect(action).toHaveBeenCalledWith('forward', {
          to: 'target-thread',
          cats: '["codex"]',
          mids: '["reply-1"]',
          partial: 'true',
        }),
      );
      await vi.waitFor(() => expect(ui.modal).toBeNull());
    } finally {
      dom.window.close();
    }
  });

  it('keeps the declared forwarding dialog busy, shows its own owner error and retries with the same selection', async () => {
    const { dom, w, data, ui, action, push } = await boot();
    try {
      data.threads.push({ ...data.threads[0], id: 'target-thread', title: 'Owner target' });
      ui.multi = true;
      ui.picked['reply-1'] = { text: true, blocks: {} };
      push();
      w.eval("A.modal({v:'forward',id:'multi'}); A.set({path:'cs.modal.to',v:'target-thread'});");
      const submit = () => w.document.querySelector('form[data-form="cafeModal"] button[type="submit"]');
      for (const blocked of [undefined, true, false]) {
        data.forwardingBlocked = blocked;
        push();
        await w.__settled();
        expect(submit().disabled).toBe(blocked !== false);
      }
      let reject!: (error: Error) => void;
      action.mockImplementation((name) =>
        name === 'forward'
          ? new Promise((_, fail) => {
              reject = fail;
            })
          : undefined,
      );
      const form = w.document.querySelector('form[data-form="cafeModal"]');
      form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(ui.modal?.busy).toBe(true));
      expect(action.mock.calls.filter(([name]) => name === 'forward')).toHaveLength(1);
      expect(submit().disabled).toBe(true);
      reject(new Error('Owner rejected forwarding'));
      await vi.waitFor(() =>
        expect(w.document.querySelector('[data-pop="chat.modal"] .dialog-body .ws-danger')?.textContent).toBe(
          'Owner rejected forwarding',
        ),
      );
      expect(ui.modal).toMatchObject({ to: 'target-thread', cats: ['codex'], messageIds: ['reply-1'], busy: false });
      expect(ui.picked['reply-1']).toBeTruthy();
      action.mockImplementation(async (name) => (name === 'forward' ? 'owner-message-bundle' : undefined));
      submit().click();
      await vi.waitFor(() => expect(ui.modal).toBeNull());
      expect(ui.multi).toBe(false);
      expect(ui.picked).toEqual({});
      expect(action.mock.calls.filter(([name]) => name === 'forward').map(([, args]) => args)).toEqual([
        { to: 'target-thread', cats: '["codex"]', mids: '["reply-1"]', partial: 'true' },
        { to: 'target-thread', cats: '["codex"]', mids: '["reply-1"]', partial: 'true' },
      ]);
    } finally {
      dom.window.close();
    }
  });

  it('closes chat.modal through the declared cancel and Esc exits without sending', async () => {
    const { dom, w, ui, action } = await boot();
    try {
      for (const exit of ['cancel', 'esc']) {
        w.eval("A.modal({v:'forward',id:'msg',i:1})");
        await w.__settled();
        expect(ui.modal).not.toBeNull();
        if (exit === 'cancel') w.document.querySelector('[data-act="close"][data-popup="chat.modal"]').click();
        else w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await vi.waitFor(() => expect(ui.modal).toBeNull());
      }
      expect(action.mock.calls.filter(([name]) => name === 'forward')).toEqual([]);
    } finally {
      dom.window.close();
    }
  });

  it.each([
    { kind: 'queueRecallAppend', args: {} },
    { kind: 'fileOverwrite', args: { name: 'owner.txt' } },
    { kind: 'memoryWiden', args: { source: 'private', target: 'public' } },
    {
      kind: 'routingRedirect',
      args: {
        code: 'ROUTING_CONFIRMATION_REQUIRED',
        error: 'recipient unavailable',
        unavailable: [{ catId: 'dsh', displayName: 'Unavailable member' }],
        targets: [{ catId: 'kimi', displayName: 'Suggested member' }],
      },
    },
  ])('resolves $kind only from its declared engine dialog decision', async ({ kind, args }) => {
    const { dom, w } = await boot(undefined, (data) => {
      data.input = 'Keep this draft';
    });
    try {
      const cancelled = w.clowderChat.confirm(kind, args);
      expect(w.document.querySelector('.dialog [type="submit"]')).not.toBeNull();
      if (kind === 'fileOverwrite') expect(w.document.querySelector('.dialog')?.textContent).toContain('owner.txt');
      if (kind === 'routingRedirect') {
        expect(w.document.querySelector('.dialog')?.textContent).toContain('Unavailable member');
        expect(w.document.querySelector('.dialog')?.textContent).toContain('Suggested member');
        expect(w.eval('S.dialog.args')).toEqual(args);
      }
      runInContext("A.close({path:'s.dialog'})", dom.getInternalVMContext());
      await expect(cancelled).resolves.toBe(false);
      expect(w.document.getElementById('chat-input').value).toBe('Keep this draft');
      const accepted = w.clowderChat.confirm(kind, args);
      const form = w.document.querySelector('form[data-form="dialog"]');
      expect(form).not.toBeNull();
      form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await expect(accepted).resolves.toBe(true);
    } finally {
      dom.window.close();
    }
  });

  it('leaves text paste native while forwarding image paste through the application port', async () => {
    const { dom, w, port } = await boot();
    try {
      const input = w.document.getElementById('chat-input');
      const plain = new w.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(plain, 'clipboardData', { value: { files: [], getData: () => 'plain text' } });
      input.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
      const image = new w.File(['image'], 'image.png', { type: 'image/png' });
      const paste = new w.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: { files: [image], getData: () => '' } });
      input.dispatchEvent(paste);
      expect(paste.defaultPrevented).toBe(true);
      expect(port.attach).toHaveBeenCalledWith([image]);
    } finally {
      dom.window.close();
    }
  });
});

function advancedMemberMetadata() {
  return {
    accounts: [],
    templates: [],
    blank: initialState(),
    codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    clients: CLIENT_OPTIONS.map((client) => ({
      id: client.value,
      label: client.label,
      carriers: carrierOptionsForClient(client.value).map((row) => [row.value, row.label]),
      accounts: [],
    })),
    strategies: [] as unknown[],
    runtimes: [] as unknown[],
    libraries: [] as unknown[],
  };
}

it('keeps the member save error and uncertain write in the declared save bar and checks before retrying', async () => {
  const meta = advancedMemberMetadata(),
    form = initialState(fixtureData().cats[0]);
  let finish!: (value: unknown) => void;
  const { dom, w, action } = await boot(undefined, undefined, undefined, {}, (port) => {
    const previous = port.action;
    port.action = (name, args, element) => {
      if (name === 'membersRead') return meta;
      if (name === 'memberSave')
        return new Promise((resolve) => {
          finish = resolve;
        });
      return previous(name, args, element);
    };
  });
  try {
    w.eval('go("member-codex")');
    await w.__settled();
    const name = w.document.getElementById('f-name');
    name.value = 'Edited name';
    name.dispatchEvent(new w.Event('input', { bubbles: true }));
    const saving = w.eval('FORMS.member()');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(w.eval('VM.member().form.save.state')).toBe('saving');
    expect(w.document.getElementById('savebar')?.textContent).toContain(w.eval("tc('memberForm.save.saving')"));
    const pendingWrite = { catId: 'codex', create: false, form, payload: {}, context: {} };
    await w.clowderChat.emit('member:save', {
      key: 'codex',
      state: 'idle',
      error: 'member_write_unconfirmed',
      baselineForm: form,
      draft: { form, baseline: null, pendingWrite },
    });
    finish(Promise.reject(new Error('reply lost')));
    await saving;
    await w.__settled();
    expect(w.eval('VM.member().form.save')).toMatchObject({
      state: 'idle',
      error: 'member_write_unconfirmed',
      pendingWrite,
    });
    expect(w.document.querySelector('.field-err[data-for="member-save"]')?.textContent).toContain(
      w.eval("tc('memberForm.save.unconfirmed')"),
    );
    expect(w.document.getElementById('f-name').value).toBe('Edited name');
    const checking = w.eval('FORMS.member()');
    expect(w.eval('VM.member().form.save.state')).toBe('checking');
    expect(w.document.getElementById('savebar')?.textContent).toContain(w.eval("tc('memberForm.save.checking')"));
    finish({ ...fixtureData().cats[0], name: 'Edited name', configurationRevision: 'new-revision' });
    await checking;
    await w.__settled();
    expect(action.mock.calls.filter(([name]) => name === 'toast')).toEqual([]);
  } finally {
    dom.window.close();
  }
});

it('keeps context policy and reference audio in the current member draft until their actual writers acknowledge them', async () => {
  const meta = advancedMemberMetadata();
  const strategy = {
    strategy: 'handoff',
    statusStrategy: 'handoff',
    warnThreshold: '70',
    actionThreshold: '90',
    maxCompressions: '2',
    source: 'config_file',
    revision: 'policy-one',
    changedAt: 1,
    executionStatus: { status: 'degraded', missingCapabilities: ['observesCompression'] },
  };
  meta.strategies = [{ id: 'codex', form: strategy }];
  let reject = true,
    finishUpload!: (value: unknown) => void;
  const policies: Record<string, string>[] = [],
    memberWrites: Record<string, string>[] = [];
  const { dom, w } = await boot(undefined, undefined, undefined, {}, (port) => {
    const previous = port.action;
    port.action = (name, args, element) => {
      if (name === 'membersRead') return meta;
      if (name === 'memberSave') {
        memberWrites.push(args);
        return { ...fixtureData().cats[0], configurationRevision: 'cat-confirmed' };
      }
      if (name === 'memberStrategySave') {
        policies.push(args);
        if (reject) return Promise.reject(new Error('policy owner rejected'));
        const form = {
          ...JSON.parse(args.value),
          statusStrategy: 'hybrid',
          revision: 'policy-confirmed',
          executionStatus: { status: 'active', missingCapabilities: [] },
        };
        meta.strategies = [{ id: 'codex', form }];
        return form;
      }
      if (name === 'memberRefAudioUpload') {
        expect((element as HTMLInputElement).files?.[0].name).toBe('reference.wav');
        return new Promise((resolve) => {
          finishUpload = resolve;
        });
      }
      return previous(name, args, element);
    };
  });
  try {
    w.eval('go("member-codex")');
    await w.__settled();
    const select = w.document.getElementById('f-ctxStrat');
    select.value = 'hybrid';
    select.dispatchEvent(new w.Event('change', { bubbles: true }));
    const count = w.document.getElementById('f-ctxMax');
    count.value = '3';
    count.dispatchEvent(new w.Event('input', { bubbles: true }));
    expect(w.eval('VM.member().form.save.n')).toBe(2);
    await w.eval('FORMS.member()');
    await w.__settled();
    expect(w.document.getElementById('f-ctxMax').value).toBe('3');
    expect(w.document.body.textContent).toContain('policy owner rejected');
    reject = false;
    await w.eval('FORMS.member()');
    await w.__settled();
    expect(memberWrites[1].expectedRevision).toBe('cat-confirmed');
    expect(JSON.parse(policies[1].value)).toMatchObject({ strategy: 'hybrid', maxCompressions: '3' });
    expect(w.eval('VM.member().form.ctxDirty')).toBe(false);
    expect(w.document.querySelector('#ms-context')?.textContent).toContain(
      w.eval("tc('memberForm.fields.savedSettings')"),
    );
    const upload = w.document.querySelector('input[type="file"][data-k="vRef"]');
    Object.defineProperty(upload, 'files', { value: [new w.File(['audio'], 'reference.wav', { type: 'audio/wav' })] });
    upload.dispatchEvent(new w.Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(finishUpload).toBeTypeOf('function'));
    finishUpload({ url: '/uploads/reference.wav' });
    await w.__settled();
    expect(w.document.querySelector('#ms-voice')?.textContent).toContain('/uploads/reference.wav');
    await w.eval('FORMS.member()');
    expect(JSON.parse(memberWrites.at(-1)!.value).voiceRefAudio).toBe('/uploads/reference.wav');
  } finally {
    dom.window.close();
  }
});

it('binds DSH inspection, exact revision preparation and optional test, then invalidates the receipt after a manual launch edit', async () => {
  const meta = advancedMemberMetadata();
  meta.runtimes = [
    {
      id: 'dsh',
      dshSetupSupported: true,
      label: 'DSH',
      installed: true,
      models: [],
      form: { clientId: 'acp', carrier: 'acp', acpCommand: 'dsh', acpStartupArgs: 'acp' },
    },
  ];
  const calls: { op: string; value: Record<string, unknown> }[] = [];
  const catalogReads: unknown[] = [];
  const { dom, w } = await boot(
    undefined,
    (data) => {
      Object.assign(data.cats[0], {
        clientId: 'acp',
        carrier: 'acp',
        configurationSource: 'native_tool',
        accountRef: '',
        acp: { command: 'dsh', startupArgs: ['acp'] },
      });
    },
    undefined,
    {},
    (port) => {
      const previous = port.action;
      port.action = (name, args, element) => {
        if (name === 'membersRead') return meta;
        if (name === 'memberRuntimeModels') {
          catalogReads.push(JSON.parse(args.value).model);
          return {
            status: 'live',
            models: [{ value: 'catalog-model', label: 'Owner model' }],
            defaultModel: 'catalog-model',
            effortOptions: [{ value: 'high', label: 'High' }],
          };
        }
        if (name === 'memberProviderSetup') {
          calls.push({ op: args.op, value: JSON.parse(args.value) });
          if (calls.length === 1)
            return Promise.reject(Object.assign(new Error('dsh_setup_profile_required'), { profiles: ['work'] }));
          if (args.op === 'inspect')
            return {
              revision: 'owner-revision',
              profiles: ['acp', 'work'],
              active: { provider: 'route', model: 'model' },
              source: { providers: [{ id: 'route', models: [{ id: 'model', label: 'Owner model' }] }] },
            };
          if (args.op === 'prepare')
            return {
              id: 'owner-receipt',
              launch: {
                acpCommand: 'dsh',
                acpStartupArgs: '--profile "work profile" acp',
                defaultModel: '',
                cliEffort: '',
              },
            };
          return { ok: true };
        }
        return previous(name, args, element);
      };
    },
  );
  try {
    w.eval('go("member-codex")');
    await w.__settled();
    w.document.querySelector('#ms-model [data-k="dsh-provider"]').click();
    expect(w.document.querySelector('#rt-dsh-profile')).not.toBeNull();
    expect(w.eval("COMBO['f-model'].map(function (c) { return c.v; })")).toEqual(['', 'catalog-model']);
    const reads = catalogReads.length,
      model = w.document.getElementById('f-model') as HTMLInputElement;
    for (const value of ['o', 'ow', 'own'])
      w.eval(
        `INPUTS.md({ type: 'input', target: Object.assign(document.getElementById('f-model'), { value: '${value}' }) })`,
      );
    await w.__settled();
    expect(catalogReads.length).toBe(reads);
    expect(w.document.getElementById('f-model')).not.toBeNull();
    model.value = '';
    w.eval("INPUTS.md({ type: 'input', target: document.getElementById('f-model') })");
    expect(w.eval('VM.member().form.preferences.catalog.models[0]')).toEqual({
      value: 'catalog-model',
      label: 'Owner model',
    });
    expect(w.eval('VM.member().form.d.effort')).toBe('');
    expect(w.document.getElementById('f-effort').value).toBe('');
    expect(calls).toEqual([]);
    await w.eval('A.memberProviderSetup({op:"inspect"})');
    expect(w.eval('VM.member().form.model.provider.error')).toBe('dsh_setup_profile_required');
    expect(w.document.querySelector('[data-for="rt-dsh-profile"][role="alert"]')?.textContent).toContain(
      'dsh_setup_profile_required',
    );
    const profile = w.document.getElementById('rt-dsh-profile');
    profile.value = 'work';
    profile.dispatchEvent(new w.Event('change', { bubbles: true }));
    await w.eval('A.memberProviderSetup({op:"inspect"})');
    expect(w.document.querySelector('[data-for="rt-dsh-profile"][role="alert"]')).toBeNull();
    await w.eval('A.memberProviderSetup({op:"prepare"})');
    expect(calls[2]).toEqual({
      op: 'prepare',
      value: { runtimeId: 'dsh', sourceProfile: 'work', revision: 'owner-revision', provider: 'route', model: 'model' },
    });
    expect(w.document.getElementById('f-acpArgs').value).toBe('--profile "work profile" acp');
    await w.eval('A.memberProviderSetup({op:"test"})');
    expect(calls[3]).toEqual({ op: 'test', value: { id: 'owner-receipt' } });
    const launch = w.document.getElementById('f-acpArgs');
    launch.value = '--profile changed acp';
    launch.dispatchEvent(new w.Event('input', { bubbles: true }));
    expect(w.document.querySelector('[data-act="memberProviderSetup"][data-op="test"]')).toBeNull();
  } finally {
    dom.window.close();
  }
});

it('creates only pending selected native partners and retains adjusted preferences and the same second request after an owner rejection', async () => {
  const meta = advancedMemberMetadata();
  const partners = ['first', 'second', 'third'].map((id) => ({
    id,
    selected: true,
    selectable: true,
    creationRequestKey: 'request-' + id,
    form: { ...initialState(), displayName: id },
    runtime: { id, installed: true, acpMaxDefault: 20, label: id, readiness: { status: 'unknown' } },
  }));
  let reject = true;
  const creates: Record<string, string>[] = [];
  const { dom, w } = await boot(undefined, undefined, undefined, {}, (port) => {
    const previous = port.action;
    port.action = (name, args, element) => {
      if (name === 'membersRead') return meta;
      if (name === 'nativeDetect') return structuredClone(partners);
      if (name === 'memberRuntimeModels')
        return { status: 'live', models: [], effortOptions: [{ value: 'high', label: 'High' }] };
      if (name === 'nativeCreate') {
        creates.push(args);
        const partner = JSON.parse(args.value);
        if (partner.id === 'second' && reject) return Promise.reject(new Error('native owner rejected'));
        return { id: partner.id };
      }
      return previous(name, args, element);
    };
  });
  try {
    w.eval('go("members")');
    await w.__settled();
    w.eval('A.open({ref:"members.detect"})');
    await w.__settled();
    expect(w.eval('VM.nativeSetup().items.find(c=>c.id==="second").runtime.readiness.status')).toBe('unknown');
    w.eval("A.nativeAdjust({id:'second'})");
    const model = w.document.getElementById('probe-second-model');
    model.value = 'chosen-model';
    model.dispatchEvent(new w.Event('input', { bubbles: true }));
    await w.__settled();
    const effort = w.document.getElementById('probe-second-effort');
    effort.value = 'high';
    effort.dispatchEvent(new w.Event('change', { bubbles: true }));
    expect(w.eval('VM.nativeSetup().items.find(c=>c.id==="second").payload.defaultModel')).toBe('chosen-model');
    await w.eval('A.nativeCreate()');
    expect(w.document.body.textContent).toContain('native owner rejected');
    expect(w.eval('VM.nativeSetup().failedPartner')).toEqual({ name: 'second', client: 'second' });
    expect(creates.map((args) => JSON.parse(args.value).id)).toEqual(['first', 'second']);
    reject = false;
    await w.eval('A.nativeCreate()');
    expect(creates.map((args) => JSON.parse(args.value).id)).toEqual(['first', 'second', 'second', 'third']);
    expect(creates[2]).toEqual(creates[1]);
    expect(JSON.parse(creates[2].value).form.defaultModel).toBe('chosen-model');
    expect(JSON.parse(creates[2].value).form.cliEffort).toBe('high');
    expect(w.document.querySelector('[data-act="nativeCreate"]').disabled).toBe(true);
  } finally {
    dom.window.close();
  }
});

it.each([
  false,
  true,
])('edits the selected plugin client library (fixed single: %s) through the records form and retains drafts on a revision conflict', async (single) => {
  const meta = advancedMemberMetadata();
  const stored = [
    {
      id: 'work',
      name: 'Original',
      command: 'agent',
      startupArgs: ['--profile', 'work profile'],
      bootstrapRoot: '/bootstrap',
      retained: 'owner field',
    },
  ];
  meta.libraries = [
    {
      pluginId: 'clients',
      configurationKey: 'CLIENTS',
      configurationMode: single ? 'single' : undefined,
      clients: [{ ref: 'plugin:clients/work' }],
      defaultClient: single ? stored[0] : undefined,
      presets: [{ id: 'preset', name: 'Preset', command: 'agent', startupArgs: ['acp'] }],
    },
  ];
  let plugin = {
    pluginId: 'clients',
    artifact: 'installed',
    displayName: 'Client library',
    lifecycleRevision: 7,
    configFields: [
      {
        key: 'CLIENTS',
        kind: 'records',
        label: 'Clients',
        recordFields: [
          { key: 'id', kind: 'string', label: 'ID', required: true },
          { key: 'name', kind: 'string', label: 'Name', required: true },
          { key: 'command', kind: 'string', label: 'Command', required: true },
          { key: 'startupArgs', kind: 'list', label: 'Args' },
          { key: 'bootstrapRoot', kind: 'string', label: 'Root' },
        ],
        required: true,
        currentValue: JSON.stringify(single ? {} : stored),
      },
    ],
  };
  let reject = true;
  const saves: Record<string, string>[] = [];
  const { dom, w } = await boot(
    undefined,
    (data) => {
      Object.assign(data.cats[0], {
        clientId: 'acp',
        carrier: 'acp',
        configurationSource: 'native_tool',
        agentProvider: 'plugin:clients/work',
        acp: { command: '', startupArgs: [] },
      });
    },
    undefined,
    {},
    (port) => {
      const previous = port.action;
      port.action = (name, args, element) => {
        if (name === 'membersRead') return meta;
        if (name === 'memberPluginRead') return plugin;
        if (name === 'memberPluginSave') {
          saves.push(args);
          if (reject) return Promise.reject(new Error('plugin revision conflict'));
          plugin = {
            ...plugin,
            lifecycleRevision: 8,
            configFields: [{ ...plugin.configFields[0], currentValue: args.value }],
          };
          return plugin;
        }
        if (name === 'memberSave') return { id: 'codex', configurationRevision: 'confirmed' };
        return previous(name, args, element);
      };
    },
  );
  try {
    w.eval('go("member-codex")');
    await w.__settled();
    const key = single ? 'command' : 'name',
      changed = single ? 'changed-agent' : 'Changed';
    const name = w.document.querySelector('[data-input="pcfRecIn"][data-k="CLIENTS#0#' + key + '"]');
    expect(name.value).toBe(single ? 'agent' : 'Original');
    name.value = changed;
    name.dispatchEvent(new w.Event('input', { bubbles: true }));
    if (single) {
      expect(w.document.querySelector('[data-k="CLIENTS#0#id"]').readOnly).toBe(true);
      expect(w.document.querySelector('[data-k="CLIENTS#0#name"]').readOnly).toBe(true);
      expect(w.document.querySelector('[data-p="mrt-c:clients"][data-op="recAdd"]')).toBeNull();
    } else {
      const root = w.document.querySelector('[data-input="pcfRecIn"][data-k="CLIENTS#0#bootstrapRoot"]');
      root.value = '';
      root.dispatchEvent(new w.Event('input', { bubbles: true }));
    }
    await w.eval('FORMS.member()');
    await w.__settled();
    expect(w.document.querySelector('[data-k="CLIENTS#0#' + key + '"]').value).toBe(changed);
    expect(w.document.body.textContent).toContain('plugin revision conflict');
    reject = false;
    await w.eval('FORMS.member()');
    await w.__settled();
    expect(saves[1]).toEqual(saves[0]);
    const profiles = JSON.parse(saves[1].value);
    if (single) {
      expect(profiles).toEqual({ command: 'changed-agent' });
      expect(JSON.parse(saves[1].fixedClient)).toEqual(stored[0]);
    } else {
      expect(profiles[0]).toMatchObject({
        name: 'Changed',
        retained: 'owner field',
        startupArgs: ['--profile', 'work profile'],
      });
      expect(profiles[0]).not.toHaveProperty('bootstrapRoot');
    }
    expect(JSON.parse(saves[1].plugin).lifecycleRevision).toBe(7);
  } finally {
    dom.window.close();
  }
});

it('renders real and preview brake events with the copied dialog, required reason and owner acknowledgement', async () => {
  const { dom, w, action } = await boot(undefined, undefined, undefined, {
    opsBrakeSettings: { enabled: true, thresholdMinutes: 150, mode: 'hardcore' },
  });
  try {
    w.clowderChat.emit('brake:show', { level: 2, minutes: 155, bypassDisabled: false });
    expect(w.document.querySelector('.dialog')?.textContent).toContain('155');
    w.document.querySelector('input[name="brake-choice"][value="continue"]').checked = true;
    await w.eval('dialogSubmit(S.dialog)');
    expect(action.mock.calls.filter(([name]) => name === 'brakeCheckin')).toHaveLength(0);
    w.document.getElementById('dlg-in').value = 'Owner reason';
    w.document.querySelector('input[name="brake-choice"][value="continue"]').checked = true;
    action.mockImplementationOnce(async () => {
      throw new Error('owner checkin rejected');
    });
    await w.eval('dialogSubmit(S.dialog)');
    expect(w.document.querySelector('.dialog')?.textContent).toContain('owner checkin rejected');
    expect(w.document.getElementById('dlg-in').value).toBe('Owner reason');
    let acknowledge!: () => void;
    action.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    w.document.querySelector('input[name="brake-choice"][value="continue"]').checked = true;
    const pending = w.eval('dialogSubmit(S.dialog)');
    expect(w.eval('S.dialog')).toBeNull(); // closed while its owner works; the trigger shows progress
    acknowledge();
    await pending;
    expect(action).toHaveBeenLastCalledWith('brakeCheckin', { choice: 'continue', reason: 'Owner reason' });
    expect(w.document.querySelector('.dialog')).toBeNull();
    const sent = action.mock.calls.length;
    w.eval('A.wsBrakePreview()');
    expect(w.document.querySelector('.dialog')?.textContent).toContain('150');
    await w.eval('dialogSubmit(S.dialog)');
    expect(action.mock.calls).toHaveLength(sent);
    w.clowderChat.emit('brake:show', { level: 3, minutes: 180, bypassDisabled: true });
    expect(w.document.querySelector('input[name="brake-choice"][value="continue"]')).toBeNull();
    expect([...w.document.querySelectorAll('input[name="brake-choice"]')].map((input) => input.value)).toEqual([
      'rest',
      'wrap_up',
    ]);
  } finally {
    await w.__settled();
    dom.window.close();
  }
});

it('renders r135 file editing and conflict actions without another editor', async () => {
  const file = {
    path: 'note.md',
    absolutePath: '/fixture/note.md',
    content: 'Original file',
    sha256: 'a'.repeat(64),
    mime: 'text/markdown',
    binary: false,
  };
  const bench = {
    ...fixtureWorkbenchSource(),
    opened: { worktreeId: 'wt', file },
    fileEdits: {
      [JSON.stringify(['wt', 'note.md'])]: { content: 'Owner draft', original: file.content, baseSha256: file.sha256 },
    },
    editing: { editMode: true, isTokenValid: true, canEdit: true, saveError: '' },
    workspace: { worktreeId: 'wt', worktrees: [{ id: 'wt', root: '/fixture' }], tree: [], loading: false, error: null },
  };
  const { dom, w, action, errors } = await boot(
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    {},
    { workbench: bench },
  );
  try {
    await w.eval("A.wsFile({ w:'wt',p:'note.md'})");
    w.eval('render(true)');
    await w.__settled();
    const input = w.document.querySelector('[data-view="file.body"] textarea');
    expect(input).not.toBeNull();
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.getAttribute('aria-label')).toBe('note.md');
    input.value = '  exact\nfile content  ';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await w.__settled();
    expect(action).toHaveBeenCalledWith('fileDraft', { id: '/fixture/note.md', content: '  exact\nfile content  ' });
    w.document.querySelector('[data-view="file.body"] [data-act="fileSave"]').click();
    await w.__settled();
    expect(action).toHaveBeenCalledWith(
      'fileSave',
      expect.objectContaining({ id: '/fixture/note.md', baseSha256: 'a'.repeat(64) }),
      undefined,
    );
    bench.editing.saveError = 'Actual file conflict';
    w.clowderChat.pushProject({ workbench: bench });
    await w.__settled();
    expect(w.document.querySelector('[data-view="file.body"]').textContent).toContain('Actual file conflict');
    const conflicts = [...w.document.querySelectorAll('[data-act="fileConflict"]')];
    expect(conflicts.map((button) => button.dataset.op)).toEqual(['reload', 'overwrite']);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});

it('uses the r135 library form values and captured Mission Hub dialog fields through the copied popup shells', async () => {
  const memoryLibraryForm = {
    draft: { kind: 'research', name: '', displayName: '', root: '', sensitivity: 'internal' },
    scan: { totalFiles: 12, markdownFiles: 7, secretFindings: 0, safe: true },
    created: null,
    busy: false,
    error: '',
  };
  const board = {
    items: [],
    featureIds: [],
    sopDefinition: { stages: [] },
    read: { load: '' },
    docs: {},
    threads: [],
    projects: [],
    projectsLoad: '',
    external: {
      id: 'captured-project',
      load: '',
      detail: {
        cards: [
          { id: 'captured-card', triage: { clarity: 2, groundedness: 2, necessity: 2, coupling: 2, sizeBand: 'M' } },
        ],
      },
    },
    riskResults: null,
    sop: { id: '', value: null, load: '' },
    browsing: false,
    dialog: { kind: 'triage', args: { kind: 'triage', projectId: 'captured-project', cardId: 'captured-card' } },
  };
  const { dom, w, action, errors } = await boot(
    undefined,
    undefined,
    undefined,
    { memoryLibraryForm },
    undefined,
    {},
    { board },
  );
  try {
    await w.eval("A.modal({ v:'lib'})");
    await w.__settled();
    expect([...w.document.querySelectorAll('#lib-type option')].map((option) => option.value)).toEqual([
      'project',
      'world',
      'domain',
      'research',
      'global',
    ]);
    for (const [id, value] of Object.entries({
      'lib-name': 'owner',
      'lib-disp': 'Owner library',
      'lib-root': '/fixture/library',
    }))
      w.document.getElementById(id).value = value;
    await w.eval("SET_AFTER['cs.modal.scan']()");
    expect(action).toHaveBeenCalledWith(
      'libraryScan',
      { name: 'owner', displayName: 'Owner library', root: '/fixture/library' },
      undefined,
    );
    expect(w.document.getElementById('lib-root').value).toBe('/fixture/library');
    await w.eval('FORMS.cafeModal()');
    expect(action).toHaveBeenCalledWith(
      'libraryCreate',
      { name: 'owner', displayName: 'Owner library', root: '/fixture/library' },
      undefined,
    );
    w.eval('CS.modal=null;render(true)');
    await w.eval("A.dialog({kind:'triage',projectId:'captured-project',cardId:'captured-card'})");
    w.document.getElementById('triage-clarity').value = '3';
    await w.eval('dialogSubmit(S.dialog)');
    expect(action).toHaveBeenCalledWith(
      'wsTriageSave',
      {
        projectId: 'captured-project',
        cardId: 'captured-card',
        body: JSON.stringify({ clarity: 3, groundedness: 2, necessity: 2, coupling: 2, sizeBand: 'M' }),
      },
      undefined,
    );
    expect(errors).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});

it('renders bound workbench tools and voice settings through the same copied declarations', async () => {
  const date = new Date(2026, 10, 3, 12).getTime();
  const source = fixtureWorkbenchSource();
  const workbench = {
    ...source,
    tasks: [{ id: 'task', title: 'Original task', status: 'todo', kind: 'work', ownerCatId: 'codex', updatedAt: date }],
    workspace: {
      ...source.workspace,
      worktreeId: 'wt',
      worktrees: [{ id: 'wt', root: '/project' }],
    },
    execution: {
      ...source.execution,
      read: {
        ...source.execution.read,
        sessions: [{ id: 'session-owner', catId: 'codex', status: 'active', seq: 0, createdAt: date, messageCount: 1 }],
      },
    },
  };
  const project = {
    workbenchState: { tkF: 'all', wt: 'wt', tjMode: 'timeline', scheduleDate: date },
    eval: {
      view: 'events',
      counts: { act: 1, settled: 0, stale: 0 },
      ledger: null,
      paw: { items: [], counts: {} },
      act: [
        {
          key: 'verdict',
          title: 'Owner eval event',
          files: {
            verdict: '/project/evals/owner/verdict.md',
            snapshot: '/project/evals/owner/snapshot.json',
            attribution: '/project/evals/owner/attribution.json',
          },
          actions: {},
        },
      ],
      actCount: 1,
      settled: [],
    },
    voiceState: { sourceId: 'mic:2', termEdit: null },
    cafeWsVoice: {
      load: '',
      service: null,
      rec: false,
      recLabel: '开始录音',
      capture: { sourceOptions: [['mic:2', 'Microphone']], sourceId: 'mic:2', canStart: true },
      items: [],
      lines: [],
      callTranscript: { items: [] },
    },
    voice: {
      load: '',
      svc: [
        {
          i: 0,
          key: 'audio-capture',
          name: '音频采集',
          sub: '运行中',
          installed: true,
          running: true,
          next: 'stopped',
          swLabel: '音频采集',
        },
      ],
      terms: [],
      dict: [],
      dictCount: 0,
      sttLang: '中文（zh）',
      prompt: '',
    },
    cafeMemory: {
      q: '',
      views: [{ v: 'all', label: '全部记忆', active: true }],
      all: {
        list: true,
        cats: [{ v: 'person', label: '人物', active: true }],
        items: [
          {
            key: 'person',
            title: 'Owner person',
            sub: '当前',
            act: 'memOpen',
            args: { family: 'person', id: 'person' },
          },
        ],
      },
    },
    memoryState: { view: 'all', cat: 'person', q: '', limits: { person: 20 } },
  };
  const { dom, w, action, port } = await boot(
    undefined,
    (data) => {
      data.executions = [
        {
          executionId: 'live-run',
          threadId: 'pdl-test',
          threadTitle: 'Owner live run',
          catId: 'codex',
          kind: 'live_invocation',
          startedAt: date - 3000,
          cancelability: { state: 'not_cancelable', reason: 'control_plane_unavailable' },
        },
      ];
    },
    undefined,
    project,
    undefined,
    {},
    {
      workbench,
      home: fixtureHomeSource(),
      recentWorks: {
        projectId: '/project',
        load: '',
        artifacts: [
          {
            navigationId: 'owner-work',
            type: 'file',
            name: 'Owner recent work',
            catId: 'codex',
            createdAt: date,
            threadId: 'pdl-test',
            threadTitle: 'Source',
          },
        ],
      },
      board: {
        items: [
          {
            id: 'owner-item',
            title: '[F901] Owner backlog feature',
            summary: '',
            tags: ['feature:f901'],
            priority: 'p1',
            status: 'open',
            createdBy: 'owner',
            createdAt: date,
            updatedAt: date,
            audit: [],
          },
        ],
        featureIds: [{ id: 'owner-item', featureId: 'F901' }],
        read: { load: '' },
        docs: {},
        threads: [],
        projects: [],
        projectsLoad: '',
        external: { id: '', load: '' },
        riskResults: null,
        sop: { id: '', load: '', value: null },
        sopDefinition: { stages: [] },
        browsing: false,
        dialog: null,
      },
      schedule: {
        ownerReads: [
          {
            envelope: { subjectRef: 'work' },
            brief: { current: { state: 'doing' } },
            work: { ownerCatId: 'codex', threadId: 'pdl-test', progress: { summary: '' } },
          },
        ],
        calendarFacts: [{ id: 'work', title: 'Owner dated work', dates: [{ role: 'actual_start', value: date }] }],
        loading: false,
        confirmed: true,
        error: null,
        partial: false,
      },
    },
  );
  try {
    for (const [panel, view, text] of [
      ['tasks', 'ws.tasks', 'Original task'],
      ['voice', 'cafe.ws.voice', 'Microphone'],
      ['exec', 'ws.exec', 'Codex'],
      ['mem', 'cafe.memory', 'Owner person'],
      ['home', 'works.recent', 'Owner recent work'],
      ['board', 'ws.board', 'Owner backlog feature'],
      ['eval', 'ws.eval', 'Owner eval event'],
      ['schedule', 'ws.schedule', 'Owner dated work'],
    ]) {
      w.eval('ENGINE_PARTS.openTab("panel",' + JSON.stringify(panel) + ');render(true)');
      await w.__settled();
      const node = w.document.querySelector('[data-view="' + view + '"]');
      expect(node?.textContent, view).toContain(text);
    }
    workbench.workspace.worktrees.push({ id: 'eval-wt', root: '/eval-owner' });
    port.data = { ...port.data, project: { ...(port.data.project as Record<string, unknown>), workbench } };
    w.clowderChat.update(port);
    project.eval.act[0].files.verdict = '/eval-owner/custom/verdict.md';
    w.clowderChat.update(port);
    w.eval('rtOpen("panel","eval");S.folds["row:eval-act"]="verdict";render(true)');
    await w.__settled();
    const evidence = w.document.querySelector('[data-view="ws.eval"] [data-act="wsFile"]');
    expect(evidence).not.toBeNull();
    evidence.click();
    await vi.waitFor(() =>
      expect(action).toHaveBeenCalledWith('fileOpen', { w: 'eval-wt', p: 'custom/verdict.md' }, undefined),
    );
    w.eval('rtOpen("panel","voice");render(true)');
    await w.__settled();
    w.document.querySelector('[data-view="cafe.ws.voice"] [data-act="wsRec"]').click();
    await vi.waitFor(() =>
      expect(action).toHaveBeenCalledWith('wsRec', expect.objectContaining({ op: 'start' }), undefined),
    );
    w.eval('go("voice");render(true)');
    await w.__settled();
    expect(w.document.querySelector('[data-view="page.voice"]')?.textContent).toContain('音频采集');
    expect(w.document.body.textContent).not.toContain('t:');
  } finally {
    dom.window.close();
  }
});

it.each([
  'delegated_cli',
  'manual_ui',
])('uses marketplace owner search and %s install plans, and refreshes the real source catalogue', async (mode) => {
  const calls: { path: string; params?: Record<string, string>; body?: unknown }[] = [];
  let degraded = false;
  const item = {
    ecosystem: 'codex',
    artifactId: 'owner-package',
    artifactKind: 'skill',
    displayName: 'Owner skill',
    sourceLocator: 'https://example.test/owner',
    trustLevel: 'community',
    componentSummary: 'Actual owner capability',
  };
  const { dom, w, errors } = await boot(undefined, undefined, undefined, {}, (port) => {
    const original = port.get;
    port.get = async (path, params) => {
      if (path === '/api/marketplace/search') {
        calls.push({ path, params });
        return {
          results: [
            item,
            {
              ...item,
              artifactId: 'installed-package',
              displayName: 'Installed owner',
              lifecycle: { installed: true },
            },
          ],
          sources: ['claude', 'codex', 'openclaw', 'antigravity'].map((ecosystem) => ({
            ecosystem,
            sourceKind: 'provider',
            availability: degraded && ecosystem === 'codex' ? 'degraded' : 'live',
            ...(degraded && ecosystem === 'codex' ? { issues: ['Provider temporarily unavailable'] } : {}),
          })),
        };
      }
      return original(path, params);
    };
    port.post = async (path, params, body) => {
      calls.push({ path, params, body });
      return path === '/api/marketplace/install/plan'
        ? {
            plan: {
              mode,
              ...(mode === 'delegated_cli' ? { delegatedCommand: 'codex install owner-package' } : {}),
              manualSteps: ['Owner install step'],
            },
          }
        : {};
    };
  });
  try {
    w.eval("go('market')");
    await w.__settled();
    expect(w.document.body.textContent).toContain('Owner skill');
    expect(w.eval('VM.market().sources')).toEqual([]);
    expect(
      w.eval(
        'VM.market().groups.map(function(g){return {kind:g.kind, names:g.items.map(function(i){return i.name})}})',
      ),
    ).toEqual([
      { kind: 'installed', names: ['Installed owner'] },
      { kind: 'available', names: ['Owner skill'] },
    ]);
    const key = JSON.stringify(['codex', 'owner-package']);
    w.eval('go(' + JSON.stringify('marketItem-' + key) + ')');
    await w.__settled();
    expect(w.eval('VM.market().sel')).toMatchObject({ eco: 'codex', availability: 'live', where: null });
    if (mode === 'delegated_cli') expect(w.document.body.textContent).toContain('codex install owner-package');
    else expect(w.document.querySelector('[data-act="mkOpenUi"]')).toBeNull(); // manual_ui has no executable settings target: steps only
    expect(w.document.querySelector('[data-view="page.market"]').textContent).not.toContain('undefined');
    expect(w.document.body.textContent).toContain('Owner install step');
    expect(calls).toContainEqual({
      path: '/api/marketplace/install/plan',
      params: {},
      body: { ecosystem: 'codex', artifactId: 'owner-package' },
    });
    const query = w.document.getElementById('mk-q');
    query.value = 'actual';
    query.dispatchEvent(new w.Event('input', { bubbles: true }));
    await w.__settled();
    expect(calls).toContainEqual({ path: '/api/marketplace/search', params: { q: 'actual' } });
    degraded = true;
    await w.eval('A.mkRefresh()');
    await w.__settled();
    expect(w.eval('VM.market().sources')).toEqual([
      { eco: 'codex', availability: 'degraded', issues: ['Provider temporarily unavailable'] },
    ]);
    expect(calls).toContainEqual({ path: '/api/plugin-manager/marketplaces/refresh', params: {}, body: {} });
    expect(errors).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});

it('waits for plugin update receipts and keeps offline installation inside the existing file dialog', async () => {
  const plugin = {
    pluginId: 'dev.owner.update',
    displayName: 'Owner plugin',
    artifact: 'installed',
    intent: 'enabled',
    lifecycleRevision: 7,
    availableVersion: '2.0.0',
    installedVersion: '1.0.0',
    contributions: [],
    actions: { install: true, setEnabled: true, uninstall: true, blockingReasons: [] },
    configFields: [],
    source: { kind: 'local-archive' },
  };
  const calls: { path: string; body: unknown }[] = [];
  const { dom, w, action, errors } = await boot(undefined, undefined, undefined, {}, (port) => {
    const original = port.get;
    port.get = async (path, params) =>
      path === '/api/plugin-manager/plugins'
        ? { plugins: [plugin] }
        : path.endsWith('/dev.owner.update')
          ? { plugin }
          : original(path, params);
    port.post = async (path, _params, body) => {
      calls.push({ path, body });
      plugin.lifecycleRevision = 8;
      return { plugin };
    };
  });
  try {
    w.eval("go('extItem','dev.owner.update')");
    await w.__settled();
    const update = w.document.querySelector('[data-act="capUpdate"]');
    expect(update).not.toBeNull();
    update.click();
    await w.eval('dialogSubmit()');
    await w.__settled();
    expect(calls).toEqual([
      {
        path: '/api/plugin-manager/plugins/dev.owner.update/update',
        body: { expectedVersion: '2.0.0', expectedRevision: 7 },
      },
    ]);
    w.eval('A.installFile()');
    await w.__settled();
    const input = w.document.getElementById('cap-file');
    Object.defineProperty(input, 'files', { value: [new w.File(['archive'], 'owner.tgz')] });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    await w.eval('dialogSubmit()');
    await w.__settled();
    expect(action).toHaveBeenCalledWith('pluginArchive', {}, input);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});

it('reads inbox confirmations and uses native mention revision coordinates for resolve, restore and undo', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const mention = {
    threadId: 'source-thread',
    messageId: 'mention-source',
    content: '@owner native mention',
    catId: 'codex',
    expectedRevision: 11,
    timestamp: 1,
  };
  let handled = false;
  const { dom, w, errors } = await boot(undefined, undefined, undefined, {}, (port) => {
    const original = port.get;
    port.get = async (path, params) => {
      if (path === '/api/concierge/work/decisions')
        return {
          status: 'available',
          observedAt: 1793664000000,
          page: { offset: 0, limit: 20, hasMore: false },
          items:
            params?.mentionPeriod === 'handled'
              ? handled
                ? [{ decisionRef: 'm', userMention: { ...mention, handledReason: 'ignored' } }]
                : []
              : handled
                ? []
                : [{ decisionRef: 'm', userMention: mention }],
        };
      if (path === '/api/concierge/confirmations')
        return {
          confirmations: [
            {
              id: 'confirm',
              messageId: 'confirm-mid',
              status: 'rendered',
              action: { kind: 'propose_thread', title: 'Native confirmation' },
            },
            {
              id: 'confirmed',
              messageId: 'confirmed-mid',
              status: 'confirmed',
              action: { kind: 'propose_thread', title: 'Native completed confirmation' },
            },
          ],
        };
      if (path === '/api/concierge/thread') return { threadId: 'concierge-owner' };
      return original(path, params);
    };
    port.post = async (path, _params, body) => {
      calls.push({ path, body });
      if (path.endsWith('/handle')) handled = true;
      if (path.endsWith('/restore') || path.endsWith('/undo')) handled = false;
      return { undoId: '938aefc1-3c5b-48e3-9764-80b217449048' };
    };
  });
  try {
    w.eval('A.inboxToggle({},document.getElementById("app"))');
    await w.__settled();
    expect(w.document.body.textContent).toContain('Native confirmation');
    w.eval("CS.ib.view='approvals';render(true)");
    await w.__settled();
    expect(w.document.body.textContent).toContain('Native confirmation');
    w.eval("CS.ib.apTab='history';render(true)");
    await w.__settled();
    expect(w.document.body.textContent).toContain('Native completed confirmation');
    w.eval("CS.ib.view='main';render(true)");
    await w.__settled();
    const done = w.document.querySelector('[data-act="cafeIbDone"][data-kind="mention"]');
    expect(done).not.toBeNull();
    done.click();
    await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith('/resolve'))).toBe(true));
    await w.__settled();
    expect(calls).toContainEqual({
      path: '/api/concierge/work/mentions/source-thread/resolve',
      body: { expectedMessageId: 'mention-source', expectedRevision: 11 },
    });
    const undo = await w.eval('ENT.ibAt.remove(ENT.ibAt.get("mention-source"))');
    expect(calls).toContainEqual({
      path: '/api/concierge/work/mentions/handle',
      body: {
        requests: [{ threadId: 'source-thread', messageId: 'mention-source', expectedRevision: 11 }],
      },
    });
    await undo();
    expect(calls).toContainEqual({
      path: '/api/concierge/work/mentions/undo',
      body: { undoId: '938aefc1-3c5b-48e3-9764-80b217449048' },
    });
    await w.eval('ENT.ibAt.remove(ENT.ibAt.get("mention-source"))');
    w.eval("CS.ib.view='ignored';CS.ib.ignTime='earlier';render(true)");
    await w.__settled();
    const restore = w.document.querySelector('[data-act="remove"][data-entity="ibIgnored"]');
    expect(restore).not.toBeNull();
    restore.click();
    await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith('/restore'))).toBe(true));
    await w.__settled();
    expect(calls).toContainEqual({
      path: '/api/concierge/work/mentions/restore',
      body: { threadId: 'source-thread', messageId: 'mention-source', expectedRevision: 11 },
    });
    expect(errors).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});

it('shows desktop companion loss only from the declared plugin space and accepts a live show receipt', async () => {
  const plugin = {
    pluginId: 'dev.owner.companion',
    displayName: 'Owner companion',
    artifact: 'installed',
    intent: 'enabled',
    actions: {},
    source: { kind: 'local-archive' },
  };
  const fragment = {
    id: 'companion',
    views: { 'owner.companion': { type: 'frame', route: 'companion', src: 'https://companion.test/client/' } },
  };
  const writes: string[] = [];
  const { dom, w, errors } = await boot(undefined, undefined, undefined, {}, (port) => {
    const original = port.get;
    port.get = async (path, params) =>
      path === '/api/plugin-manager/plugins'
        ? { plugins: [plugin] }
        : path === '/api/plugin-manager/pdl'
          ? { fragments: { [plugin.pluginId]: fragment } }
          : path === '/api/concierge/desktop'
            ? { presence: null, desktopLost: true, lossId: 'actual-loss' }
            : original(path, params);
    port.post = async (path) => {
      writes.push(path);
      return { presence: { state: 'visible', maxAgeMs: 15000 } };
    };
  });
  try {
    w.eval("go('companion')");
    await w.__settled();
    expect(w.document.querySelector('iframe[src="https://companion.test/client/"]')).not.toBeNull();
    const restore = w.document.querySelector('[data-act="companionRestore"]');
    expect(restore.dataset.lossId).toBe('actual-loss');
    restore.click();
    await vi.waitFor(() => expect(writes).toEqual(['/api/concierge/desktop/show']));
    await w.__settled();
    expect(w.document.querySelector('[data-act="companionRestore"]')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});

it('opens the declared branch text dialog and dispatches its original source and edited content', async () => {
  const { dom, w, ui, action, errors } = await boot();
  try {
    w.eval("A.modal({v:'branch',mid:'reply-1'})");
    await w.__settled();
    const input = w.document.getElementById('br-text');
    expect(input.value).toContain('消息已接入');
    input.value = 'Branch input';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    const form = w.document.querySelector('form[data-form="cafeModal"]');
    expect(form).not.toBeNull();
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(action).toHaveBeenCalledWith('threadBranch', { mid: 'reply-1', text: 'Branch input' }),
    );
    await vi.waitFor(() => expect(ui.modal).toBeNull());
    expect(errors).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});

it('labels the declared queue continue control from copy and sends the actual entry id and selected mode', async () => {
  const { dom, w, action, errors } = await boot(undefined, (data) => {
    data.queue.push({
      id: 'actual-queue',
      threadId: data.threadId,
      userId: 'owner',
      content: 'Owner queued input',
      messageId: 'queued-source',
      mergedMessageIds: [],
      from: { kind: 'user', userId: 'owner' },
      targetCats: ['codex'],
      intent: 'execute',
      status: 'queued',
      createdAt: 1,
    });
  });
  try {
    const send = w.document.querySelector('[data-act="cafeQueueSend"]');
    expect(send.getAttribute('aria-label')).toBe('现在发出');
    send.click();
    await w.__settled();
    const cut = w.document.querySelector('input[name="steer"][value="cut"]');
    cut.checked = true;
    await w.eval('dialogSubmit()');
    await w.__settled();
    expect(action).toHaveBeenCalledWith('cafeQueueSend', { id: 'actual-queue', mode: 'cut' });
    expect(errors).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});

describe('W2 handler coverage', () => {
  it('registers wsMore with the prototype tab conditions and runs the existing focus, split and close actions', async () => {
    const { dom, w, buildModels, errors } = await boot();
    try {
      w.eval(
        "navTabs('panel').list=[{k:'files'},{k:'team'},{k:'tasks'}];rtMenuSt('panel').pins=['team'];rtShow('panel','files');render(true)",
      );
      const items = () => w.eval("menuItems('wsMore')");
      const run = (data: object) => {
        w.__menuAction = data;
        return w.eval('A[__menuAction.act](__menuAction.data)');
      };
      expect(items()).toMatchObject([
        {
          label: '专注',
          help: '只留当前这个工具常驻打开，其他标签先收起；聊天照常在旁边',
          act: 'toggle',
          data: { path: 'ws.focus' },
        },
        { label: '左右并排', act: 'tab', data: { op: 'split', r: 'panel' }, cur: false },
        { label: '关闭其他标签', act: 'tab', data: { op: 'closeOthers', r: 'panel' } },
        { label: '关闭全部未固定标签', act: 'tab', data: { op: 'closeUnpinned', r: 'panel' } },
        { label: '收起工作台', act: 'close', data: { path: 's.panel' } },
      ]);
      w.document.querySelector('.ws-headacts [data-menu="wsMore"]').click();
      await w.__settled();
      expect(w.document.querySelector('[data-pop="menu"]')?.textContent).toContain('关闭其他标签');
      w.document.querySelector('[data-pop="menu"] [data-act="toggle"]').click();
      await w.__settled();
      expect(w.eval('S.ws.focus')).toBe(true);
      expect(items()[0]).toMatchObject({ label: w.eval("tc('frame.exitFocus')"), help: undefined });
      await run(items()[0]);
      expect(w.eval('S.ws.focus')).toBe(false);
      await run(items()[1]);
      expect(w.eval("navTabs('panel').split")).toEqual({ left: 'files', right: null });
      expect(items()[1].cur).toBe(true);
      await run(items()[1]);
      expect(w.eval("navTabs('panel').split")).toBeNull();
      await run(items()[2]);
      expect(w.eval("navTabs('panel').list.map(function(t){return t.k;})")).toEqual(['team', 'files']);
      expect(items().some((item: { data?: { op?: string } }) => item.data?.op === 'closeOthers')).toBe(false);
      await run(items().find((item: { data?: { op?: string } }) => item.data?.op === 'closeUnpinned'));
      expect(w.eval("navTabs('panel').list.map(function(t){return t.k;})")).toEqual(['team']);
      expect(w.eval('S.panel')).toBe('home');
      expect(items().some((item: { act: string }) => item.act === 'toggle')).toBe(false);
      w.eval("navTabs('panel').list=[{k:'team'}];rtShow('panel','team');render(true)");
      expect(items().map((item: { act: string }) => item.act)).toEqual(['toggle', 'close']);
      w.eval("navTabs('panel').split={left:'team',right:null}");
      expect(items()[1]).toMatchObject({ data: { op: 'split', r: 'panel' }, cur: true });
      w.eval("navTabs('panel').split=null;S.panelWide=true");
      await run(items().at(-1));
      expect(w.eval('[S.panel,S.panelWide]')).toEqual([null, false]);
      expect(buildModels).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });

  it('registers wsRec with numeric menu coordinates and downloads only the held real recording source', async () => {
    const voice = {
      ...ownerData().voice,
      saved: {
        owner: 'pdl-test',
        summary: {
          recording_paths: { mic: '/recordings/first.wav', app: '/recordings/second.wav' },
          recording_path: '/recordings/first.wav',
        },
      },
      worktrees: [{ id: 'voice-wt', root: '/recordings', branch: 'main' }],
    };
    voice.services = { ...voice.services, load: '' };
    const { dom, w, port, buildModels, errors } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      {},
      { voice },
    );
    try {
      w.eval("ENGINE_PARTS.openTab('panel','voice');");
      w.document.querySelectorAll('[data-view="cafe.ws.voice"] .lr-head').forEach((el: HTMLElement) => el.click());
      const items = () =>
        [...w.document.querySelectorAll('[data-view="cafe.ws.voice"] [data-act="download"]')]
          .filter((el) => el.dataset.source.includes('second.wav') || el.dataset.source.includes('changed.wav'))
          .map((el) => ({
            act: 'download',
            data: { source: decodeURIComponent(el.dataset.source), name: decodeURIComponent(el.dataset.name) },
          }));
      const source = 'https://api.test/api/workspace/file/download?worktreeId=voice-wt&path=second.wav';
      expect(items()).toMatchObject([{ act: 'download', data: { source, name: 'second.wav' } }]);
      expect(w.eval('VM.cafeWsVoice().items')).toHaveLength(2);
      const download = vi.fn();
      w.__download = download;
      w.eval('PLATFORM.download=__download');
      w.__downloadArgs = items()[0].data;
      w.eval('A.download(window.__downloadArgs)');
      expect(download).toHaveBeenCalledWith('second.wav', { url: source });
      w.eval("A.close({path:'s.menu'})");
      const render = vi.fn(w.eval('render'));
      w.__menuRender = render;
      w.eval('render=__menuRender');
      const get = vi.mocked(port.get).mockClear();
      const post = vi.mocked(port.post).mockClear();
      expect(w.clowderChat.pushProject({ voice })).toEqual({
        voice: { added: [], changed: [], removed: [], orderChanged: false, fields: [] },
      });
      expect(render).not.toHaveBeenCalled();
      voice.saved.summary.recording_paths.app = '/recordings/changed.wav';
      expect(items()[0].data.source).toBe(source);
      expect(w.clowderChat.pushProject({ voice })).toEqual({
        voice: {
          added: [],
          changed: [],
          removed: [],
          orderChanged: false,
          fields: ['voice.saved.summary.recording_paths.app'],
        },
      });
      await w.__settled();
      expect(render).toHaveBeenCalledTimes(1);
      expect(items()[0].data).toEqual({
        source: 'https://api.test/api/workspace/file/download?worktreeId=voice-wt&path=changed.wav',
        name: 'changed.wav',
      });
      voice.saved.summary.recording_paths.app = '/outside/changed.wav';
      w.clowderChat.pushProject({ voice });
      await w.__settled();
      expect(items()).toMatchObject([]);
      expect(buildModels).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });

  it('keeps the r145 quota view without the removed demo menu trigger', async () => {
    const { dom, w, buildModels, errors } = await boot(undefined, undefined, undefined, () => ({
      cafeWsOps: {
        load: '',
        cur: 'quota',
        sections: [{ v: 'quota', label: '额度与用量' }],
        facts: { refreshedAt: '', usage: { calls: 0, total: 0, input: 0, output: 0, cost: 0 } },
        quota: {
          refreshLabel: '刷新',
          pools: [],
          route: [],
          routeNote: '',
          days: [],
          cats: [],
          tf: '',
          tt: '',
          tr: 7,
          toolStats: { calls: 0, success: 0, error: 0 },
          bars: [],
          tools: [],
          toolCats: [],
        },
      },
    }));
    try {
      w.eval("ENGINE_PARTS.openTab('panel','ops');render(true)");
      await w.__settled();
      expect(w.eval('typeof MENU_FNS.wsQuotaM')).toBe('undefined');
      expect(w.eval('typeof A.wsQuotaNotify')).toBe('undefined');
      expect(w.eval("menuItems('wsQuotaM')")).toEqual([]);
      expect(w.document.querySelector('[data-view="cafe.ws.ops"] [data-menu="wsQuotaM"]')).toBeNull();
      expect(buildModels).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      dom.window.close();
    }
  });

  it('opens, searches and toggles the workbench launcher through the declared trigger', async () => {
    const { dom, w } = await boot();
    try {
      await w.eval('A.wsReopen({})');
      expect(w.eval('S.panel')).toBe('home');
      w.eval("A.wsPop({v:'launcher'},document.querySelector('[data-act=wsPop]'))");
      expect(w.document.querySelector('[data-pop="ws.launcher"]')).not.toBeNull();
      expect(w.document.activeElement?.id).toBe('ws-q');
      w.eval("INPUTS.wsQ({target:{value:'missing-tool-query'}})");
      expect(w.eval('S.wsQ')).toBe('missing-tool-query');
      expect(w.document.querySelector('[data-pop="ws.launcher"]')?.textContent).toContain('missing-tool-query');
      w.eval("A.wsPop({v:'launcher'},document.querySelector('[data-act=wsPop]'))");
      expect(w.document.querySelector('[data-pop="ws.launcher"]')).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('opens a directory in the file tool and creates a file relative to that directory', async () => {
    const { dom, w, action } = await boot(undefined, undefined, undefined, {
      files: { load: '', tree: {}, found: [], modes: [] },
    });
    try {
      await w.eval("A.dirOpen({ p:'src/'})");
      expect(w.eval('S.ws.dir')).toBe('src/');
      expect(w.eval('S.panel')).toBe('files');
      w.eval("A.dialog({kind:'wcCreate',k:'file'})");
      w.document.getElementById('dlg-in').value = 'note.md';
      await w.eval('dialogSubmit()');
      expect(action).toHaveBeenCalledWith('fileCreate', { kind: 'file', path: 'src/note.md' }, undefined);
    } finally {
      dom.window.close();
    }
  });

  it('reopens the last visible tool outside a conversation and retains an explicit tool view', async () => {
    const { dom, w, ui, action } = await boot();
    action.mockImplementation((name, args) => {
      if (name === 'worksPage') (ui.workspace!.reviews as { works: { page: boolean } }).works.page = args.v === 'true';
    });
    try {
      w.eval("S.lastPanel='files'; rtEnsure('panel','exec'); rtShow('panel','exec'); go('works'); S.panel=null");
      expect(w.eval('S.lastPanel')).toBe('files');
      await w.eval('A.wsReopen({})');
      expect(w.eval('S.panel')).toBe('files');
      await w.eval("A.wsTool({ k:'team',view:'prefs'})");
      expect(w.eval("navArg('view',navTabKey('panel','team'))")).toBe('prefs');
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('scrolls a stream tick after the draw restores its reading anchor, including an unchanged host push', async () => {
    let state = fixtureUi();
    const { dom, w, ui, action, port } = await boot(
      undefined,
      (_data, value) => {
        state = value;
      },
      undefined,
      {},
      (commands) => {
        vi.mocked(commands.action).mockImplementation((name, args) => {
          if (name === 'jump') state.pendingMid = args.mid;
        });
      },
    );
    try {
      const scroll = vi.fn(function (this: HTMLElement) {
        expect(w.eval('window.readingAnchorRestored')).toBe(true);
        expect(this.dataset.mid).toBe('reply-1');
      });
      w.HTMLElement.prototype.scrollIntoView = scroll;
      w.eval(
        'window.readingAnchorRestored=false; beforeRender(function(){window.readingAnchorRestored=false;}); onRender(function(){window.readingAnchorRestored=true;})',
      );
      w.clowderChat.update(port);
      w.document.querySelector('.cafe-tick[data-mid="reply-1"]').click();
      await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(action).toHaveBeenCalledWith('jump', expect.objectContaining({ mid: 'reply-1' }), undefined);
      expect(ui.pendingMid).toBeUndefined();
    } finally {
      await w.__settled();
      dom.window.close();
    }
  });

  it('registers evaluation actions with the same DOM-backed domain and explicit duty arguments', async () => {
    const { dom, w, action } = await boot();
    try {
      const input = w.document.createElement('input');
      input.id = 'op-dom-owner-domain';
      input.value = 'Owner @codex';
      w.document.body.append(input);
      await w.eval("A.opDomCat({k:'owner-domain'})");
      await w.eval("A.opDutySave({field:'backup',v:'Owner @codex'})");
      expect(action).toHaveBeenCalledWith('opDomCat', { k: 'owner-domain', v: 'Owner @codex' }, undefined);
      expect(action).toHaveBeenCalledWith('opDutySave', { field: 'backup', v: 'Owner @codex' }, undefined);
      expect(w.eval('A.wsFlag')).toBeUndefined();
    } finally {
      dom.window.close();
    }
  });

  it('routes workspace quotation, text annotation/save and review comparison through their existing owners', async () => {
    const { dom, w, action } = await boot();
    try {
      await w.eval("A.workFileQuote({work:'/project/note.md',quote:'Owner quote'})");
      expect(action).toHaveBeenCalledWith(
        'workFileQuote',
        { work: '/project/note.md', quote: 'Owner quote' },
        undefined,
      );
      await w.eval("A.workTextAnnotate({id:'/project/note.md',quote:'Owner quote'})");
      expect(action).toHaveBeenCalledWith(
        'workTextAnnotate',
        { id: '/project/note.md', quote: 'Owner quote' },
        undefined,
      );
      expect(w.document.activeElement?.id).toBe('an-text');
      w.document.getElementById('an-text').value = 'Owner opinion';
      w.document.getElementById('an-text').dispatchEvent(new w.Event('input', { bubbles: true }));
      await w.eval('FORMS.cafeModal()');
      expect(action).toHaveBeenCalledWith('workTextSave', { body: 'Owner opinion' });
      await w.eval("A.workReviewCompare({round:'2'})");
      expect(action).toHaveBeenCalledWith('workReviewCompare', { round: '2' }, undefined);
    } finally {
      dom.window.close();
    }
  });

  it('registers filmMark for the frozen screening selection and returns to the conversation after acceptance', async () => {
    const { dom, w, action } = await boot();
    try {
      w.eval("CS.pop={kind:'textsel'}");
      await w.eval(
        "A.filmMark({id:'project-owner',screening:'screening-owner',mediaId:'media-owner',at:'1.5',x:'4',y:'8',width:'12',height:'16'})",
      );
      expect(action).toHaveBeenCalledWith(
        'filmMark',
        {
          id: 'project-owner',
          screening: 'screening-owner',
          mediaId: 'media-owner',
          at: '1.5',
          x: '4',
          y: '8',
          width: '12',
          height: '16',
        },
        undefined,
      );
      expect(w.eval('CS.pop')).toBeNull();
      expect(w.eval('S.route')).toBe('chat');
    } finally {
      dom.window.close();
    }
  });

  it('projects replay from the pushed held snapshot without pulling models and registers direct source changes', async () => {
    let replay = {
      thread: 'pdl-test',
      source: 'F901',
      load: '',
      events: [],
      engine: {
        state: 'idle',
        speed: 100,
        currentIndex: 0,
        totalEvents: 0,
        elapsedMs: 0,
        totalDurationMs: 0,
        displayMode: 'cinematic',
        adaptivePacing: true,
        bulletTime: null,
      },
      typingMs: null,
      guideLanguage: 'zh',
      guideScript: [],
      guideHtml: '',
      guideTeam: {},
      messages: [],
      chapters: [],
      features: [{ id: 'feature-owner', featureId: 'F901', title: 'Current feature' }],
    };
    const { dom, w, port, action, buildModels } = await boot(
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      {},
      { replay },
    );
    try {
      buildModels.mockClear();
      replay = { ...replay, features: replay.features.map((row) => ({ ...row, title: 'Unpushed title' })) };
      for (let i = 0; i < 100; i++) expect(w.eval('VM.replay().sources[1].name')).toBe('Current feature');
      expect(buildModels).not.toHaveBeenCalled();
      port.data = { ...port.data, project: { ...(port.data.project as Record<string, unknown>), replay } };
      w.clowderChat.update(port);
      expect(w.eval('VM.replay().sources[1].name')).toBe('Unpushed title');
      await w.eval("A.rpSource({v:'F901'})");
      expect(action).toHaveBeenCalledWith('rpSource', { v: 'F901' }, undefined);
    } finally {
      dom.window.close();
    }
  });
});

it('renders message Markdown with the library once per unchanged message and invalidates only its changed Markdown', async () => {
  const { dom, w } = await boot();
  try {
    w.eval(
      'chatMarkdown.clear();window.mdCalls=0;window.realMsgMd=msgMd;msgMd=function(data){window.mdCalls++;return window.realMsgMd(data);}',
    );
    expect(w.eval("chatMessageVM({mid:'raw-message',md:'**Raw body**'}).html")).toContain('<b>Raw body</b>');
    for (let i = 0; i < 20; i++) w.eval("chatMessageVM({mid:'raw-message',md:'**Raw body**'})");
    expect(w.mdCalls).toBe(1);
    expect(w.eval("chatMessageVM({mid:'raw-message',md:'**Changed body**'}).html")).toContain('<b>Changed body</b>');
    expect(w.mdCalls).toBe(2);
  } finally {
    await w.__settled();
    dom.window.close();
  }
});

it('opens the declared vote form for the slash command without sending, and ends through the real owner', async () => {
  const { dom, w, action, port } = await boot();
  try {
    action.mockClear();
    w.eval("CS.draft['chat-input']='/vote Owner question'");
    await w.eval("A.send({for:'chat-input'})");
    expect(w.document.getElementById('vote-question').value).toBe('Owner question');
    expect(action.mock.calls.some(([name]) => name === 'send')).toBe(false);
    expect(port.post).not.toHaveBeenCalled();
    w.eval("S.dialog=null;CS.draft['chat-input']='/vote end'");
    await w.eval("A.send({for:'chat-input'})");
    expect(action).toHaveBeenCalledWith('cafeVoteEnd', {}, undefined);
  } finally {
    dom.window.close();
  }
});

it('opens the declared native-review target from the real Git review control and preserves its catId', async () => {
  const bench = fixtureWorkbenchSource();
  const { dom, w, action, errors } = await boot(
    undefined,
    undefined,
    undefined,
    { workbenchState: { reviewOpen: true } },
    undefined,
    {},
    {
      workbench: {
        ...bench,
        git: { ...bench.git, load: '' },
        native: { load: '', reviews: [], nativeTargets: [{ catId: 'codex' }, { catId: 'opus' }] },
      },
    },
  );
  try {
    w.eval("ENGINE_PARTS.openTab('panel','git');render(true)");
    await w.__settled();
    const trigger = w.document.querySelector('[data-act="wcReviewStart"]');
    expect(trigger).not.toBeNull();
    trigger.click();
    const select = w.document.getElementById('native-review-cat');
    expect(Array.from(select.options, (option: HTMLOptionElement) => option.value)).toEqual(['codex', 'opus']);
    expect(action.mock.calls.filter(([name]) => name === 'wcReviewStart')).toEqual([]);
    select.value = 'opus';
    await w.eval('dialogSubmit()');
    expect(action).toHaveBeenCalledWith('wcReviewStart', { catId: 'opus' }, undefined);
    expect(w.document.querySelector('.dialog')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await w.__settled();
    dom.window.close();
  }
});

it('opens the preference retirement declaration from the entity action and retains its reason on rejection', async () => {
  const { dom, w, action, errors } = await boot(undefined, undefined, undefined, {
    teamPreferences: [{ preferenceId: 'owner-pref', status: 'active' }],
  });
  try {
    w.eval("A.setStatus({entity:'pref',id:'owner-pref',v:'retired'})");
    expect(w.document.getElementById('dlg-reason')).not.toBeNull();
    expect(action.mock.calls.filter(([name]) => name === 'routingPreferenceRetire')).toEqual([]);
    w.document.getElementById('dlg-reason').value = 'Owner retirement reason';
    action.mockRejectedValueOnce(new Error('Owner revision changed'));
    await w.eval('dialogSubmit()');
    expect(w.document.querySelector('.dialog')?.textContent).toContain('Owner revision changed');
    expect(w.document.getElementById('dlg-reason').value).toBe('Owner retirement reason');
    await w.eval('dialogSubmit()');
    expect(action).toHaveBeenLastCalledWith('routingPreferenceRetire', {
      id: 'owner-pref',
      reason: 'Owner retirement reason',
    });
    expect(w.document.querySelector('.dialog')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await w.__settled();
    dom.window.close();
  }
});

it('keeps AGY permission as a boolean through the declared select and the member save owner', async () => {
  const metadata = advancedMemberMetadata();
  const writes: Record<string, string>[] = [];
  const { dom, w, errors } = await boot(
    undefined,
    (data) => Object.assign(data.cats[0], { clientId: 'google', carrier: 'cli', agyProfile: { carrier: 'native' } }),
    undefined,
    {},
    (port) => {
      const previous = port.action;
      port.action = async (name, args, element) => {
        if (name === 'membersRead') return metadata;
        if (name === 'memberSave') {
          writes.push(args);
          return {
            ...fixtureData().cats[0],
            clientId: 'google',
            carrier: 'cli',
            agyProfile: { carrier: 'native' },
            configurationRevision: 'owner-revision',
          };
        }
        return previous(name, args, element);
      };
    },
  );
  try {
    w.eval("go('member-codex')");
    await w.__settled();
    for (const value of [true, false]) {
      const select = w.document.getElementById('f-agyPerm');
      expect(Array.from(select.options, (option: HTMLOptionElement) => option.value)).toEqual(['false', 'true']);
      select.value = String(value);
      select.dispatchEvent(new w.Event('change', { bubbles: true }));
      expect(w.eval('VM.member().form.d.agyPerm')).toBe(value);
    }
    await w.eval('FORMS.member()');
    expect(JSON.parse(writes[0].value).agyAutoApprove).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await w.__settled();
    dom.window.close();
  }
});

it('reads PR changes for the work session once its changes view is projected', async () => {
  const reviews = { ...contentRuntimeReviews(), worktreeId: 'worktree' };
  Object.assign(reviews.openedWork.artifact, { type: 'pr', ref: 'owner/repo#7', url: '' });
  const target = {
    kind: 'github-pr',
    v: 1,
    repoFullName: 'owner/repo',
    prNumber: 7,
    worktreeId: 'worktree',
    threadId: 'source-thread',
  };
  const result = {
    target,
    comparison: { baseSha: 'base', headSha: 'head' },
    changedFiles: [{ path: 'src/main.ts', status: 'modified' }],
    diff: 'diff --git a/src/main.ts b/src/main.ts\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-before\n+after\n',
    completeness: 'complete',
  };
  const { dom, w, port, buildModels, errors } = await boot(
    undefined,
    undefined,
    undefined,
    {},
    (port) => {
      const get = port.get;
      port.get = vi.fn(async (path, params) =>
        path === '/api/workspace/chat-pull-request-changes' ? result : get(path, params),
      );
    },
    {},
    { reviews },
  );
  try {
    expect(port.get).not.toHaveBeenCalledWith('/api/workspace/chat-pull-request-changes', expect.anything());
    await w.eval("A.workPrChanges({id:'work-one'})");
    await w.__settled();
    expect(port.get).toHaveBeenCalledWith('/api/workspace/chat-pull-request-changes', {
      target: encodeURIComponent(JSON.stringify(Object.values(target))),
    });
    expect(w.eval('VM.git().prChanges')).toMatchObject({
      target,
      load: '',
      files: [
        {
          path: 'src/main.ts',
          add: 1,
          del: 1,
          diff: {
            hunks: [
              [
                '@@ -1 +1 @@',
                [
                  ['-', 'before'],
                  ['+', 'after'],
                ],
              ],
            ],
          },
        },
      ],
    });
    const reads = vi.mocked(port.get).mock.calls.length;
    w.eval('render(true);VM.git();VM.git()');
    await w.__settled();
    expect(vi.mocked(port.get).mock.calls.length).toBe(reads);
    expect(buildModels).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});

it('keeps a cover write operation after an unknown result and retries that exact version and intent', async () => {
  const reviews = contentRuntimeReviews();
  reviews.openedWork.artifact.type = 'video';
  const reference = { contentRef: 'work-one', ownerRevision: 3 };
  let cover = { reference, coverRevision: 0, state: 'frame' };
  const commands: unknown[] = [];
  const { dom, w } = await boot(
    undefined,
    undefined,
    undefined,
    {},
    (port) => {
      const get = port.get;
      port.get = vi.fn(async (path, params) =>
        path === '/api/works/cover'
          ? structuredClone(cover)
          : path === '/api/works/cover/candidates'
            ? { candidates: [] }
            : get(path, params),
      );
      const post = port.post;
      port.post = vi.fn(async (path, params, body) => {
        if (path !== '/api/works/cover') return post(path, params, body);
        commands.push(structuredClone(body));
        if (commands.length === 1) throw Object.assign(new Error('reply lost'), { status: 503 });
        cover = { ...cover, coverRevision: 1 };
        return { status: 'saved', cover };
      });
    },
    {},
    { reviews },
  );
  try {
    w.eval("A.workCoverOpen({id:'work-one'})");
    await w.__settled();
    expect(w.document.querySelector('[data-act="workCoverUpload"]')).not.toBeNull();
    expect(await w.eval("A.workCoverSave({mode:'frame'})")).toBe(false);
    expect(w.eval('VM.workCover().operation.operationId')).toBeTypeOf('string');
    expect(await w.eval('A.workCoverSave({})')).toBe(true);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[1]).toMatchObject({ command: { reference, expectedCoverRevision: 0, choice: { mode: 'frame' } } });
    expect(w.eval('VM.workCover().operation')).toBeNull();
  } finally {
    await w.__settled();
    dom.window.close();
  }
});

it('holds matter pages by source and keeps the request id for an unsure edit retry', async () => {
  let matter = {
    matterId: 'matter',
    title: 'Owner matter',
    description: 'Owner description',
    status: 'active',
    revision: 4,
    updatedAt: 1,
  };
  const writes: Record<string, unknown>[] = [];
  const { dom, w, port, buildModels, errors } = await boot(
    undefined,
    undefined,
    undefined,
    {},
    (port) => {
      const get = port.get;
      port.get = vi.fn(async (path, params) =>
        path === '/api/memory/matters'
          ? { items: [matter], nextCursor: null }
          : path === '/api/memory/matters/matter'
            ? { matter, entries: [], nextCursor: null, summaryStatus: 'current' }
            : get(path, params),
      );
      const post = port.post;
      port.post = vi.fn(async (path, params, body) => {
        if (path !== '/api/memory/matters/write') return post(path, params, body);
        const command = body as Record<string, unknown>;
        writes.push(structuredClone(command));
        if (writes.length === 1) throw Object.assign(new Error('unknown receipt'), { status: 503 });
        matter = { ...matter, title: String(command.title), revision: 5 };
        return { outcome: 'edited', matter };
      });
    },
    {},
    { memory: ownerData().memory },
  );
  try {
    expect(port.get).not.toHaveBeenCalledWith('/api/memory/matters', expect.anything());
    w.eval("go('memory');A.matterOpen({id:''})");
    await w.__settled();
    expect(errors).not.toHaveBeenCalled();
    expect(w.eval('VM.cafeMemory().view')).toBe('matters');
    expect(w.document.body.textContent).toContain('Owner matter');
    w.eval("A.matterOpen({id:'matter'})");
    await w.__settled();
    w.eval('A.matterEdit()');
    w.document.getElementById('matter-title').value = 'Changed title';
    await w.eval('dialogSubmit(S.dialog)');
    await w.__settled();
    expect(w.eval('VM.memoryMatters().retryable')).toBe(true);
    expect(await w.eval('A.matterRetry()')).toBe(true);
    await w.__settled();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[1]).toMatchObject({
      operation: 'edit',
      matterId: 'matter',
      expectedRevision: 4,
      title: 'Changed title',
    });
    expect(w.eval('VM.memoryMatters().matter.title')).toBe('Changed title');
    expect(buildModels).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});

it('reads watcher sources only in the projection and writes configuration and nudge decisions with their owner revisions', async () => {
  let settings = {
    config: {
      enabled: true,
      scope: 'selected',
      memberCatId: 'codex',
      revision: 3,
      doNotDisturbLabelIds: [] as string[],
    },
    members: [],
    availableLabels: [{ id: 'quiet', name: 'Owner label' }],
  };
  let suggestion = {
    id: 'suggestion',
    threadId: 'pdl-test',
    messageId: 'reply-1',
    catId: 'codex',
    byline: 'watcher',
    kind: 'scheduled-task',
    kindLabel: 'Owner kind',
    label: 'Owner action',
    state: 'open',
    undo: null,
    receiptOnly: false,
    revision: 5,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 10,
  };
  const { dom, w, port, errors } = await boot(
    undefined,
    (data) => {
      data.messages[1].extra = {
        watcher: {
          kind: 'nudge',
          sourceInvocationId: 'source',
          sourceMessageId: 'user-1',
          watcherInvocationId: 'watcher',
        },
      };
    },
    undefined,
    { systemGeneral: { load: '', send: 'next' } },
    (port) => {
      const get = port.get;
      port.get = vi.fn(async (path, params) =>
        path === '/api/watcher/config'
          ? structuredClone(settings)
          : path === '/api/threads/pdl-test/suggestions'
            ? { threadId: 'pdl-test', suggestions: [suggestion] }
            : path === '/api/rules'
              ? {
                  sharedRules: [],
                  providerGuides: [],
                  l0Prompts: { template: { path: 'rules.md', exists: true, consumption: {}, content: '' } },
                }
              : path === '/api/prompt-injection/manifest'
                ? { segments: [] }
                : get(path, params),
      );
      const post = port.post;
      port.post = vi.fn(async (path, params, body) => {
        if (path === '/api/watcher/config') {
          settings = {
            ...settings,
            config: { ...settings.config, ...(body as { doNotDisturbLabelIds: string[] }), revision: 4 },
          };
          return structuredClone(settings);
        }
        if (path === '/api/suggestions/suggestion/apply') {
          suggestion = { ...suggestion, state: 'applied', revision: 6 };
          return { suggestion };
        }
        return post(path, params, body);
      });
    },
  );
  try {
    expect(port.get).not.toHaveBeenCalledWith('/api/watcher/config', undefined);
    expect(w.eval('VM.chatStream().items.find(x=>x.mid==="reply-1").suggestions')).toEqual([suggestion]);
    expect(await w.eval("A.watcherNudge({threadId:'pdl-test',id:'suggestion',decision:'apply'})")).toBe(true);
    expect(port.post).toHaveBeenCalledWith('/api/suggestions/suggestion/apply', {}, { expectedRevision: 5 });
    expect(w.eval('VM.chatStream().items.find(x=>x.mid==="reply-1").suggestions[0].state')).toBe('applied');
    w.eval("go('rules')");
    await w.__settled();
    await w.eval("A.watcherQuietLabel({id:'quiet'})");
    await w.__settled();
    expect(port.post).toHaveBeenCalledWith(
      '/api/watcher/config',
      { method: 'PUT' },
      { expectedRevision: 3, doNotDisturbLabelIds: ['quiet'] },
    );
    expect(w.eval('VM.watcherSettings().availableLabels[0].muted')).toBe(true);
    const count = vi.mocked(port.get).mock.calls.length;
    w.eval('VM.watcherSettings();VM.watcherSettings();render(true)');
    await w.__settled();
    expect(vi.mocked(port.get).mock.calls.length).toBe(count);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    dom.window.close();
  }
});
