// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { CommitDetail, GitCommit } from '@/hooks/useGitPanel';
import type { SearchResult } from '@/hooks/useWorkspaceSearch';
import type { useExecutionBindings } from '../useExecutionBindings';
import { fixtureData } from './chat-fixture';
import { createOwnerConsole } from './owner-console';
import { memoryInput, ownerData } from './owner-fixtures';

function projection() {
  const data = fixtureData();
  data.threadId = 'thread';
  data.threads = [{ ...data.threads[0], id: 'thread', projectPath: '/synthetic-project' }];
  data.cats = [{ ...data.cats[0], id: 'cat', displayName: 'Owner', mentionPatterns: ['@owner'] }];
  data.executions = [];
  const state = {
    tkF: 'all',
    q: '',
    qMode: 'all',
    fileMode: 'render',
    gitView: 'status',
    diffMode: 'unified',
    reviewOpen: false,
    review: { target: 'uncommitted', mode: 'session', base: 'main', sha: '', ask: '' },
    tjMode: 'timeline',
    execQ: '',
    pane: 'mine',
    recallFor: null as string | null,
    recallExpected: 0,
    execDetail: null as string | null,
  };
  const workspace = {
    worktreeId: 'wt',
    worktrees: [{ id: 'wt', root: '/synthetic-project', branch: 'topic' }],
    tree: [{ name: 'note.md', path: 'note.md', type: 'file' }],
    loading: false,
    error: null,
  };
  const owners = {
    workbench: {
      workspace,
      opened: null as unknown,
      fileInfo: { scope: '', load: '' },
      patch: undefined as unknown,
      fileEdits: {},
      editing: { canEdit: true, editMode: false, isTokenValid: true, saveError: null },
      tasks: [{ id: 'task', kind: 'work', title: 'Owner task', status: 'todo', createdAt: 0, updatedAt: 0 }],
      git: {
        id: 'wt',
        load: '',
        data: {
          status: { staged: [], unstaged: [], untracked: [] },
          log: { commits: [] as (GitCommit & Pick<CommitDetail, 'files'>)[] },
          health: { runtimeDrift: null, worktrees: [], staleBranches: [] },
        },
      },
      native: { load: '', reviews: [], nativeTargets: [] },
      fileSearch: { results: [] as SearchResult[], loading: false, error: null },
      execution: {
        invocations: {},
        external: { threadId: 'thread', load: '', sessions: [] },
        externalDetail: null,
        read: { threadId: 'thread', load: '', sessions: [], runs: [] },
        detail: null as unknown,
        search: {
          threadId: 'thread',
          query: '',
          load: '',
          hits: [] as ReturnType<typeof useExecutionBindings>['data']['search']['hits'],
        },
      },
      recall: {
        threadId: 'thread',
        load: '',
        page: { readStatus: 'ready', nextCursor: null },
        replies: [],
        events: [
          {
            id: 'recall',
            query: 'Owner query',
            toolName: 'search_evidence',
            timestamp: 1,
            catId: 'cat',
            reply: { id: 'message', timestamp: 1 },
            results: [
              {
                title: 'Owner profile',
                sourceType: 'profile',
                sourceHref: '/memory?family=profile&memoryId=profile&revision=r1',
                documentSource: false,
              },
            ],
          },
        ],
      },
    },
    terminal: {
      worktreeId: 'wt',
      load: '',
      available: true,
      mine: { id: 'terminal', status: 'connected', output: 'Owner output', cols: 80, rows: 24 },
      panes: [
        { paneId: '%1', invocationId: 'agent-1', catId: 'cat', status: 'running', startedAt: 1 },
        { paneId: '%2', invocationId: 'agent-2', catId: 'cat', status: 'running', startedAt: 2 },
      ],
      outputs: {},
    },
    home: {
      heldWaits: [],
      waits: {
        projection: {
          items: ['wait-1', 'wait-2'].map((taskId) => ({
            taskId,
            taskTitle: 'Owner wait',
            state: 'ready_to_return',
            condition: { kind: 'revision_included', revision: 'abcdefghi', services: ['web'] },
            createdAt: 0,
            matchedAt: 1,
            ownerCatId: 'cat',
            threadId: 'thread',
          })),
          candidate: null,
        },
        hydration: 'ready',
      },
      hydration: 'ready',
      unavailable: [],
      selected: null,
      detail: { id: '', load: 'loading', read: undefined as unknown },
    },
    recentWorks: {
      projectId: '/synthetic-project',
      load: '',
      artifacts: [
        {
          navigationId: 'exact-owner-key',
          name: 'Owner work',
          type: 'file',
          catId: 'cat',
          threadTitle: 'Owner thread',
          createdAt: 0,
        },
      ],
    },
  };
  const models = vi.fn(() => {
    throw new Error('Pull is forbidden');
  });
  const console = createOwnerConsole({ data, ws: state, sources: owners });
  const render = vi.fn();
  Object.assign(console.context, { render, chatModels: models, chatPort: { models }, binding: { models } });
  const push = () => {
    console.context.__incoming = owners;
    return console.read('pushProjectData(__incoming)');
  };
  return { owners, state, models, render, push, read: console.read };
}

it('projects workspace task, tree, file and diff data with console-owned presentation choices', () => {
  const { owners, state, models, push, read } = projection();
  owners.workbench.opened = {
    worktreeId: 'wt',
    file: {
      path: 'note.md',
      absolutePath: '/synthetic-project/note.md',
      mime: 'text/markdown',
      binary: false,
      content: '# Owner text',
      sha256: 'sha',
    },
  };
  push();
  expect(read('workbenchModels().tasks.items[0].title')).toBe('Owner task');
  expect(read('workbenchModels().files.tree[""][0].path')).toBe('note.md');
  expect(read('workbenchModels().filePage.mode')).toBe('render');
  state.fileMode = 'src';
  expect(read('workbenchModels().filePage.mode')).toBe('src');
  expect(models).not.toHaveBeenCalled();
});

it('projects normalized invocation timeline records without a host read or another transcript parser', () => {
  const { owners, state, models, push, read } = projection();
  owners.workbench.execution.detail = {
    invocationId: 'invocation',
    summary: { catId: 'cat', sessionSeq: 0, keyMessages: [], startedAt: 0, status: 'done' },
    events: [],
    timelineRows: [
      {
        id: 'tool',
        kind: 'tool',
        timestamp: 1,
        toolName: 'read_file',
        source: 'host_cli',
        resultStatus: 'success',
        result: 'Owner content',
        durationMs: 2,
      },
    ],
  };
  push();
  expect(read('executionModel("").run.events[0].toolName')).toBe('read_file');
  state.tjMode = 'raw';
  expect(read('executionModel("").run.mode')).toBe('raw');
  expect(models).not.toHaveBeenCalled();
});

it('keeps canonical recall source/reply coordinates and projects the console selection from held records', () => {
  const { state, models, read } = projection();
  expect(read('recallModel().groups[0].items[0].ctx.source')).toEqual({
    family: 'profile',
    id: 'profile',
    revision: 'r1',
  });
  state.recallFor = 'message';
  expect(read('recallModel().filterFor')).toBe('message');
  expect(read('recallModel().groups[0].count')).toBe(1);
  expect(models).not.toHaveBeenCalled();
});

it('uses the same held recall event and source/reply projection in workbench and memory exploration', () => {
  const original = projection(),
    source = original.owners.workbench.recall,
    memory = ownerData().memory;
  const events = source.events.map((event) => ({ ...event, threadId: source.threadId, threadTitle: 'Owner thread' }));
  const console = createOwnerConsole({
    data: { ...fixtureData(), threadId: source.threadId },
    ws: original.state,
    sources: {
      workbench: original.owners.workbench,
      memory: {
        ...memory,
        explore: { ...memory.explore, recall: { ...memory.explore.recall, page: source.page, events } },
      },
    },
  });
  Object.assign(console.context, { chatModels: original.models, chatPort: { models: original.models } });
  console.context.CS.m = { ...memoryInput(), view: 'recall' };
  const workbench = console.read('recallModel().groups[0].items[0]');
  const unpushed = events.map((event) => ({
    ...event,
    results: event.results.map((row) => ({ ...row, title: 'Unpushed memory title' })),
  }));
  expect(unpushed[0].results[0].title).toBe('Unpushed memory title');
  for (let i = 0; i < 30; i++) {
    const group = console.read('projectMemoryExplore().recall.groups[0]'),
      entry = group.items[0];
    expect(group).toMatchObject({ title: 'Owner thread', threadId: source.threadId });
    expect(entry).toMatchObject({ mid: workbench.mid, canLocate: true, thread: source.threadId });
    expect(entry.deliveries).toEqual(workbench.results);
    expect(entry.deliveries[0]).toMatchObject({
      title: 'Owner profile',
      ctx: {
        source: { family: 'profile', id: 'profile', revision: 'r1' },
        reply: { mid: 'message', thread: source.threadId },
      },
    });
  }
  expect(original.models).not.toHaveBeenCalled();
});

it('projects held terminal output without reading the socket owner', () => {
  const { owners, models, push, read } = projection();
  expect(read('terminalModels().terminal.screen.output')).toBe('Owner output');
  owners.terminal = { ...owners.terminal, mine: { ...owners.terminal.mine, output: 'New owner output' } };
  expect(read('terminalModels().terminal.screen.output')).toBe('Owner output');
  push();
  expect(read('terminalModels().terminal.screen.output')).toBe('New owner output');
  expect(models).not.toHaveBeenCalled();
});

it('projects home activity and recent owner work without invoking a pull builder', () => {
  const { models, read } = projection();
  expect(read('homeModels().live.count')).toBe(0);
  expect(read('recentWorksModels().recentWorks.rw.works.items[0].id')).toBe('exact-owner-key');
  expect(models).not.toHaveBeenCalled();
});

function unchangedAndSingleRecord(
  console: ReturnType<typeof projection>,
  owner: 'workbench' | 'terminal' | 'home' | 'recentWorks',
  records: string,
  id: string,
  expression: string,
  before: string,
  after: string,
  mutate: () => void,
) {
  const { push, read, render, models } = console;
  push();
  render.mockClear();
  const item = read(`projectData('${owner}').${records}[0]`),
    sibling = read(`projectData('${owner}').${records}[1]`);
  const unchanged = Object.fromEntries(
    Object.keys(console.owners).map((name) => [
      name,
      { added: [], changed: [], removed: [], orderChanged: false, fields: [] },
    ]),
  );
  expect(read(expression)).toBe(before);
  expect(push()).toEqual(unchanged);
  expect(render).not.toHaveBeenCalled();
  mutate();
  expect(read(expression)).toBe(before);
  expect(read(`projectData('${owner}').${records}[0]`)).toBe(item);
  expect(push()).toEqual({
    ...unchanged,
    [owner]: { added: [], changed: [id], removed: [], orderChanged: false, fields: [] },
  });
  expect(render).toHaveBeenCalledExactlyOnceWith(true);
  expect(read(expression)).toBe(after);
  expect(read(`projectData('${owner}').${records}[0]`)).not.toBe(item);
  expect(read(`projectData('${owner}').${records}[1]`)).toBe(sibling);
  expect(push()).toEqual(unchanged);
  expect(render).toHaveBeenCalledOnce();
  expect(models).not.toHaveBeenCalled();
}

it('holds workbench sources and diffs a changed task by id without rendering unchanged pushes', () => {
  const console = projection(),
    tasks = console.owners.workbench.tasks;
  tasks.push({ ...tasks[0], id: 'task-sibling' });
  unchangedAndSingleRecord(
    console,
    'workbench',
    'tasks',
    'task',
    'workbenchModels().tasks.items[0].title',
    'Owner task',
    'Changed task',
    () => {
      console.owners.workbench = {
        ...console.owners.workbench,
        tasks: tasks.map((row, i) => (i === 0 ? { ...row, title: 'Changed task' } : row)),
      };
    },
  );
});

it('holds nested execution records and diffs only the changed canonical timeline id', () => {
  const console = projection();
  const rows = ['tool', 'sibling-tool'].map((id) => ({
    id,
    kind: 'tool',
    timestamp: 1,
    toolName: 'read_file',
    source: 'host_cli',
    resultStatus: 'success',
    result: 'Owner result',
    durationMs: 2,
  }));
  console.owners.workbench.execution.detail = {
    invocationId: 'invocation',
    summary: { catId: 'cat', sessionSeq: 0, keyMessages: [], startedAt: 0, status: 'done' },
    events: [],
    timelineRows: rows,
  };
  unchangedAndSingleRecord(
    console,
    'workbench',
    'execution.detail.timelineRows',
    'tool',
    'executionModel("").run.events[0].result',
    'Owner result',
    'Changed result',
    () => {
      console.owners.workbench = {
        ...console.owners.workbench,
        execution: {
          ...console.owners.workbench.execution,
          detail: {
            ...(console.owners.workbench.execution.detail as object),
            timelineRows: rows.map((row, i) => (i === 0 ? { ...row, result: 'Changed result' } : row)),
          },
        },
      };
    },
  );
});

it('holds nested recall records and diffs only the changed recall event id', () => {
  const console = projection(),
    events = console.owners.workbench.recall.events;
  events.push({
    ...events[0],
    id: 'recall-sibling',
    reply: { id: 'other-message', timestamp: 2 },
    results: events[0].results.map((result) => ({ ...result })),
  });
  unchangedAndSingleRecord(
    console,
    'workbench',
    'recall.events',
    'recall',
    'recallModel().groups.find(g=>g.key==="message").items[0].results[0].title',
    'Owner profile',
    'Changed profile',
    () => {
      console.owners.workbench = {
        ...console.owners.workbench,
        recall: {
          ...console.owners.workbench.recall,
          events: events.map((row, i) =>
            i === 0
              ? {
                  ...row,
                  results: row.results.map((result, j) => (j === 0 ? { ...result, title: 'Changed profile' } : result)),
                }
              : row,
          ),
        },
      };
    },
  );
});

it('holds terminal source records and diffs only the changed invocation id', () => {
  const console = projection(),
    panes = console.owners.terminal.panes;
  unchangedAndSingleRecord(
    console,
    'terminal',
    'panes',
    'agent-1',
    'terminalModels().terminal.panes[1].state',
    'running',
    'crashed',
    () => {
      console.owners.terminal = {
        ...console.owners.terminal,
        panes: panes.map((row, i) => (i === 0 ? { ...row, status: 'crashed' } : row)),
      };
    },
  );
});

it('holds home deployment source records and diffs only the changed task id', () => {
  const console = projection(),
    waits = console.owners.home.waits.projection.items;
  unchangedAndSingleRecord(
    console,
    'home',
    'waits.projection.items',
    'wait-1',
    'homeModels().live.waits.items[0].title',
    'Owner wait',
    'Changed wait',
    () => {
      console.owners.home = {
        ...console.owners.home,
        waits: {
          ...console.owners.home.waits,
          projection: {
            ...console.owners.home.waits.projection,
            items: waits.map((row, i) => (i === 0 ? { ...row, taskTitle: 'Changed wait' } : row)),
          },
        },
      };
    },
  );
});

it('holds recent-work source records and diffs only the changed canonical navigation id', () => {
  const console = projection(),
    works = console.owners.recentWorks.artifacts;
  works.push({ ...works[0], navigationId: 'sibling-owner-key' });
  unchangedAndSingleRecord(
    console,
    'recentWorks',
    'artifacts',
    'exact-owner-key',
    'recentWorksModels().recentWorks.rw.works.items[0].name',
    'Owner work',
    'Changed work',
    () => {
      console.owners.recentWorks = {
        ...console.owners.recentWorks,
        artifacts: works.map((row, i) => (i === 0 ? { ...row, name: 'Changed work' } : row)),
      };
    },
  );
});

it('keeps multiple transcript hits in the same session distinct from the same event number in another session', () => {
  const console = projection(),
    search = console.owners.workbench.execution.search;
  search.query = 'owner';
  search.hits = [
    { sessionId: 'session-1', kind: 'event', pointer: { eventNo: 1 }, snippet: 'Owner first hit' },
    { sessionId: 'session-1', kind: 'event', pointer: { eventNo: 2 }, snippet: 'Owner second hit' },
    { sessionId: 'session-2', kind: 'event', pointer: { eventNo: 1 }, snippet: 'Owner third hit' },
  ];
  console.push();
  const third = console.read("projectData('workbench').execution.search.hits[2]");
  unchangedAndSingleRecord(
    console,
    'workbench',
    'execution.search.hits',
    JSON.stringify(['session-1', 1]),
    'executionModel("owner").hits[0].preview',
    'Owner first hit',
    'Changed first hit',
    () => {
      console.owners.workbench = {
        ...console.owners.workbench,
        execution: {
          ...console.owners.workbench.execution,
          search: {
            ...search,
            hits: search.hits.map((row, i) => (i === 0 ? { ...row, snippet: 'Changed first hit' } : row)),
          },
        },
      };
    },
  );
  expect(console.read("projectData('workbench').execution.search.hits[2]")).toBe(third);
});

it.each([false, true])('keeps same-file search matches distinct when matchType is present: %s', (typed) => {
  const console = projection(),
    search = console.owners.workbench.fileSearch;
  search.results = [1, 2].map((line) => ({
    path: 'note.md',
    line,
    content: 'Owner first match',
    contextBefore: '',
    contextAfter: '',
    ...(typed ? { matchType: 'content' as const } : {}),
  }));
  if (typed) search.results.push({ ...search.results[0], matchType: 'filename' });
  console.push();
  const third = typed ? console.read("projectData('workbench').fileSearch.results[2]") : null;
  unchangedAndSingleRecord(
    console,
    'workbench',
    'fileSearch.results',
    JSON.stringify(['note.md', 1, typed ? 'content' : undefined]),
    'workbenchModels().files.found[0].text',
    'Owner first match',
    'Changed first match',
    () => {
      console.owners.workbench = {
        ...console.owners.workbench,
        fileSearch: {
          ...search,
          results: search.results.map((row, i) => (i === 0 ? { ...row, content: 'Changed first match' } : row)),
        },
      };
    },
  );
  if (typed) expect(console.read("projectData('workbench').fileSearch.results[2]")).toBe(third);
});

it('uses the real git commit hash as source identity', () => {
  const console = projection(),
    commits = console.owners.workbench.git.data.log.commits;
  commits.push(
    ...['hash-1', 'hash-2'].map((hash) => ({
      hash,
      short: hash,
      author: 'Owner',
      date: '2026-11-04',
      subject: 'Owner commit',
      files: [],
    })),
  );
  unchangedAndSingleRecord(
    console,
    'workbench',
    'git.data.log.commits',
    'hash-1',
    'workbenchModels().git.commits[0].subject',
    'Owner commit',
    'Changed commit',
    () => {
      console.owners.workbench = {
        ...console.owners.workbench,
        git: {
          ...console.owners.workbench.git,
          data: {
            ...console.owners.workbench.git.data,
            log: { commits: commits.map((row, i) => (i === 0 ? { ...row, subject: 'Changed commit' } : row)) },
          },
        },
      };
    },
  );
});

it('uses the real job transition revision as source identity', () => {
  const console = projection(),
    transitions = [1, 2].map((revision) => ({ revision, state: 'running', at: 1 }));
  console.state.execDetail = 'job';
  console.owners.home.detail = {
    id: 'job',
    load: '',
    read: {
      taskId: 'job',
      catId: 'cat',
      access: { lifecycleVisibility: 'full' },
      cancelable: false,
      job: { originTaskId: 'job', createdAt: 0, state: 'running', transitions },
    },
  };
  unchangedAndSingleRecord(
    console,
    'home',
    'detail.read.job.transitions',
    '1',
    'homeModels().execDetail.trace[0].state',
    'running',
    'failed',
    () => {
      console.owners.home = {
        ...console.owners.home,
        detail: {
          ...console.owners.home.detail,
          read: {
            ...(console.owners.home.detail.read as { job: object }),
            job: {
              ...(console.owners.home.detail.read as { job: object }).job,
              transitions: transitions.map((row, i) => (i === 0 ? { ...row, state: 'failed' } : row)),
            },
          },
        },
      };
    },
  );
});
