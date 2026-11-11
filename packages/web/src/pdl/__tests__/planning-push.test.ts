// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { usePreviewBindings } from '../usePreviewBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { createOwnerConsole } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
vi.mock('@/components/workspace/useHmrStatus', () => ({ useHmrStatus: () => 'connected' }));
afterEach(async () => {
  await cleanup();
  document.querySelectorAll('iframe').forEach((frame) => frame.remove());
});

function consoleProjection(owner: string, source: unknown, state: Record<string, unknown> = {}) {
  const console = createOwnerConsole({ sources: { [owner]: source }, ws: state });
  const models = vi.fn(() => {
    throw new Error('host models must not be read');
  });
  const projectChatModels = vi.fn((data: { messages: unknown[] }) => ({ chatStream: { items: data.messages } }));
  const render = vi.fn();
  console.context.S.pv = state;
  console.context.chatPort = { models };
  console.context.render = render;
  console.context.__projectChat = projectChatModels;
  console.read('projectChat=__projectChat');
  const push = (next: unknown) => {
    console.context.__incoming = { [owner]: next };
    return console.read('pushProjectData(__incoming)');
  };
  return { project: console.read, push, models, projectChatModels, render };
}

it('projects board selection and dependency views from the held feature records', () => {
  let source = {
    items: [
      { id: 'item', title: '[F900] Owner feature', tags: ['F900'], status: 'open', priority: 'p1' },
      { id: 'neighbor', title: '[F901] Neighbor feature', tags: ['F901'], status: 'open', priority: 'p1' },
    ],
    featureIds: [
      { id: 'item', featureId: 'F900' },
      { id: 'neighbor', featureId: 'F901' },
    ],
    read: { load: '' },
    docs: {},
    threads: [],
    projects: [],
    projectsLoad: '',
    external: { id: '', load: '' },
    riskResults: null,
    sop: { id: '', value: null, load: '' },
    sopDefinition: { stages: [] },
    browsing: false,
    dialog: null,
  };
  const ui = { boardV: 'list', hbItem: null, hbView: 'sug', depScope: 'all', node: null, zoom: 1, pan: [0, 0] };
  const console = consoleProjection('board', source, ui);
  const before = console.project("projectData('board').items");
  expect(console.push(source)).toEqual({
    board: { added: [], changed: [], removed: [], orderChanged: false, fields: [] },
  });
  expect(console.render).not.toHaveBeenCalled();
  source = {
    ...source,
    items: source.items.map((row, i) => (i ? row : { ...row, title: '[F900] Unpushed source change' })),
  };
  for (let i = 0; i < 100; i++) expect(console.project('boardModels().hubPanel.feats[0].name')).toBe('Owner feature');
  ui.boardV = 'deps';
  expect(console.project('boardModels().hubPanel.deps.graph.nodes[0].id')).toBe('F900');
  expect(console.push(source)).toEqual({
    board: { added: [], changed: ['item'], removed: [], orderChanged: false, fields: [] },
  });
  expect(console.render).toHaveBeenCalledExactlyOnceWith(true);
  const after = console.project("projectData('board').items");
  expect(after[0]).not.toBe(before[0]);
  expect(after[1]).toBe(before[1]);
  expect(console.project('boardModels().hubPanel.feats[0].name')).toBe('Unpushed source change');
  expect(console.models).not.toHaveBeenCalled();
});

it('projects calendar rows from canonical date facts and the local selected day', () => {
  const date = new Date(2026, 10, 5, 12).getTime();
  const read = {
    envelope: { subjectRef: 'work:one' },
    brief: { current: { state: 'doing' } },
    work: { ownerCatId: 'owner-cat', threadId: 'source-thread', progress: { summary: 'Actual progress' } },
  };
  let source = {
    ownerReads: [read, { ...read, envelope: { subjectRef: 'work:two' } }],
    calendarFacts: [
      { id: 'work:one', title: 'Source Work', dates: [{ role: 'actual_start', value: date }] },
      { id: 'work:two', title: 'Neighbor Work', dates: [] },
    ],
    loading: false,
    confirmed: true,
    error: null,
    partial: false,
  };
  const ui = { scheduleDate: date, scheduleMode: 'month' };
  const console = consoleProjection('schedule', source, ui);
  const before = console.project("projectData('schedule').ownerReads");
  expect(console.push(source)).toEqual({
    schedule: { added: [], changed: [], removed: [], orderChanged: false, fields: [] },
  });
  expect(console.render).not.toHaveBeenCalled();
  expect(console.project('scheduleModels().schedule.items[0].title')).toBe('Source Work');
  ui.scheduleDate = new Date(2026, 10, 6, 12).getTime();
  expect(console.project('scheduleModels().schedule.items.length')).toBe(0);
  ui.scheduleDate = date;
  source = {
    ...source,
    ownerReads: source.ownerReads.map((row, i) =>
      i ? row : { ...row, work: { ...row.work, progress: { summary: 'Changed progress' } } },
    ),
  };
  for (let i = 0; i < 100; i++)
    expect(console.project('scheduleModels().schedule.items[0].summary')).toBe('Actual progress');
  expect(console.push(source)).toEqual({
    schedule: { added: [], changed: ['work:one'], removed: [], orderChanged: false, fields: [] },
  });
  expect(console.render).toHaveBeenCalledExactlyOnceWith(true);
  const after = console.project("projectData('schedule').ownerReads");
  expect(after[0]).not.toBe(before[0]);
  expect(after[1]).toBe(before[1]);
  expect(console.project('scheduleModels().schedule.items[0].summary')).toBe('Changed progress');
  expect(console.models).not.toHaveBeenCalled();
});

it('projects preview filters from held bridge entries without rereading host state', () => {
  let source = {
    gateway: { load: '', port: 4000 },
    discovered: { load: '', services: [] },
    health: { key: 'thread:3013', reachable: true },
    threadId: 'thread',
    src: 'https://gateway.test/source',
    hmr: 'connected',
    receipt: null,
    pendingAuto: null,
    target: { port: 3013, path: '/' },
    ready: true,
    capturing: false,
    warn: '',
    console: [
      { id: '1', level: 'warn', args: ['Source warning'], timestamp: 1 },
      { id: '2', level: 'info', args: ['Neighbor log'], timestamp: 1 },
    ],
  };
  const ui = { tabs: [{ id: 'tab', port: 3013, path: '/' }], active: 'tab', consoleOpen: true, filter: 'warn' };
  const console = consoleProjection('preview', source, ui);
  const before = console.project("projectData('preview').console");
  expect(console.push(source)).toEqual({
    preview: { added: [], changed: [], removed: [], orderChanged: false, fields: [] },
  });
  expect(console.render).not.toHaveBeenCalled();
  source = { ...source, console: source.console.map((row, i) => (i ? row : { ...row, args: ['Unpushed warning'] })) };
  for (let i = 0; i < 100; i++)
    expect(console.project('previewModels().preview.log.entries[0].args[0]')).toBe('Source warning');
  expect(console.project('previewModels().previewState.console[0].args[0]')).toBe('Source warning');
  expect(console.project('previewModels().preview.noShot')).toBe(false);
  ui.filter = 'error';
  expect(console.project('previewModels().preview.log.entries.length')).toBe(0);
  expect(console.push(source)).toEqual({
    preview: { added: [], changed: ['1'], removed: [], orderChanged: false, fields: [] },
  });
  expect(console.render).toHaveBeenCalledExactlyOnceWith(true);
  const after = console.project("projectData('preview').console");
  expect(after[0]).not.toBe(before[0]);
  expect(after[1]).toBe(before[1]);
  expect(console.project('previewModels().previewState.console[0].args[0]')).toBe('Unpushed warning');
  expect(console.models).not.toHaveBeenCalled();
});

it('projects replay controls and transcript nodes from held source events and normalized messages', () => {
  let source = {
    thread: 'thread',
    source: 'thread',
    load: '',
    typingMs: null,
    engine: {
      state: 'paused',
      currentIndex: 1,
      speed: 10,
      adaptivePacing: true,
      displayMode: 'cinematic',
      elapsedMs: 0,
      totalDurationMs: 1000,
    },
    events: [
      {
        index: 0,
        eventNo: 10,
        invocationId: 'turn-one',
        type: 'message',
        role: 'assistant',
        catId: 'codex',
        content: 'Source message',
        timestamp: 1000,
      },
      {
        index: 1,
        eventNo: 11,
        invocationId: 'turn-two',
        type: 'message',
        role: 'assistant',
        catId: 'codex',
        content: 'Neighbor message',
        timestamp: 1100,
      },
      {
        index: 2,
        eventNo: 12,
        invocationId: 'turn-two',
        type: 'thinking',
        role: 'assistant',
        catId: 'codex',
        content: 'Future thought',
        timestamp: 1200,
      },
    ],
    messages: [
      { id: 'replay_0', content: 'Source message', type: 'assistant', catId: 'codex' },
      { id: 'replay_1', content: 'Neighbor message', type: 'assistant', catId: 'codex' },
    ],
    chapters: [{ eventIndex: 0, label: 'Session Start', timestamp: 1000 }],
    features: [],
    guideScript: [],
    guideHtml: '',
    guideLanguage: 'zh',
    guideTeam: {},
  };
  const console = consoleProjection('replay', source);
  const before = console.project("projectData('replay')");
  expect(console.push(source)).toEqual({
    replay: { added: [], changed: [], removed: [], orderChanged: false, fields: [] },
  });
  expect(console.render).not.toHaveBeenCalled();
  expect(console.project('replayModels().theater.player.time.count')).toBe(2);
  for (let i = 0; i < 100; i++)
    expect(console.project('replayModels().theater.items[0].content')).toBe('Source message');
  source = {
    ...source,
    events: source.events.map((row, i) => (i === 2 ? { ...row, content: 'Updated future thought' } : row)),
  };
  expect(console.push(source)).toEqual({
    replay: { added: [], changed: ['12'], removed: [], orderChanged: false, fields: [] },
  });
  expect(console.render).toHaveBeenCalledExactlyOnceWith(true);
  const after = console.project("projectData('replay')");
  expect(after.events[0]).toBe(before.events[0]);
  expect(after.events[1]).toBe(before.events[1]);
  expect(after.events[2]).not.toBe(before.events[2]);
  expect(after.messages).toBe(before.messages);
  source = { ...source, messages: source.messages.map((row, i) => (i ? row : { ...row, content: 'Unpushed change' })) };
  expect(console.project('replayModels().theater.items[0].content')).toBe('Source message');
  expect(console.projectChatModels).toHaveBeenCalledWith(
    expect.objectContaining({
      messages: [
        expect.objectContaining({ content: 'Source message' }),
        expect.objectContaining({ content: 'Neighbor message' }),
      ],
    }),
    expect.objectContaining({ viewCat: null, multi: false }),
  );
  console.push({
    ...source,
    storyId: 'feat:next',
    eventTimes: [1000, 1100, 1200],
    annotations: {
      storyId: 'feat:previous',
      load: 'error',
      error: 'Previous owner error',
      value: { annotations: [{ id: 'previous', content: 'Previous narration', at: 1000 }] },
    },
  });
  expect(console.project('replayModels().theater.rp.annotation')).toMatchObject({
    storyId: 'feat:next',
    at: 1100,
    error: '',
    items: [],
  });
  expect(console.models).not.toHaveBeenCalled();
});

it('assigns stable distinct identities to accepted preview entries with the same timestamp', async () => {
  useChatStore.setState({
    currentThreadId: 'pdl-test',
    workspacePreview: { port: 3013, path: '/' },
    pendingPreviewAutoOpen: null,
  });
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(path === '/api/preview/status' ? { available: true, gatewayPort: 4100 } : { reachable: true }),
      ),
  );
  const data = fixtureData();
  const { result } = renderHook(() => usePreviewBindings(data, undefined, true));
  await waitFor(() => expect(result.current.data.src).not.toBe(''));
  const frame = document.createElement('iframe');
  frame.src = result.current.data.src;
  document.body.append(frame);
  await act(() => result.current.action('previewFrame', {}, frame));
  const append = (text: string) =>
    result.current.action(
      'pvFrameMessage',
      {
        event: new MessageEvent('message', {
          data: { source: 'cat-cafe-bridge', type: 'console', level: 'log', args: [text], timestamp: 1 },
          origin: new URL(frame.src).origin,
          source: frame.contentWindow,
        }) as unknown as string,
      },
      frame,
    );
  await act(() => append('First event'));
  const first = result.current.data.console[0];
  await act(() => append('Second event'));
  const entries = result.current.data.console;
  expect(entries.map((entry) => entry.timestamp)).toEqual([1, 1]);
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
  expect(entries[0]).toBe(first);
  expect(entries[0].id).toBe(first.id);
  await act(() => result.current.action('pvLogClear', {}));
  await act(() => append('After clear'));
  expect(result.current.data.console[0].id).not.toBe(first.id);
  expect(Number(result.current.data.console[0].id)).toBeGreaterThan(Number(entries[1].id));
});
