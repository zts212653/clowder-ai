// @vitest-environment node

import { Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { programFixture } from '@/components/capability-evolution/__tests__/evolution-fixtures';
import { rosterModel } from '@/components/routing-context/__tests__/team-panel-fixtures';
import { fixtureData } from './chat-fixture';
import { createOwnerConsole, ownerConsole, ownerFunctions } from './owner-console';
import { ownerData } from './owner-fixtures';

const ui = {
  teamV: 'roster',
  teamSub: null,
  teamByThread: {},
  sigView: 'list',
  sigSt: 'inbox',
  sigTier: 'all',
  sigSrc: 'all',
  sigQ: '',
  sigSel: {},
  tlDays: '7',
  fetchRes: '',
  sigDetail: null,
  evoId: null,
  evoReading: {},
  opsView: 'daemon',
  obsV: 'overview',
  lbRange: 'all',
  toolCat: '',
  toolType: '',
  toolRange: 7,
  evalView: 'overview',
  pawF: 'all',
};
const data = fixtureData();
function team() {
  const before = { ...ownerData().team, value: structuredClone(rosterModel), loading: false };
  if (before.value.resolution.state !== 'fresh') throw new Error('Expected fresh fixture');
  before.value.resolution.snapshot.candidates[0].profile = {
    state: 'applied',
    revision: {
      v: 1,
      catId: 'codex-sol',
      modelId: 'model',
      dossierRevision: 'r1',
      updatedAt: 1,
      relevantSignals: [{ kind: 'strength', summary: 'before', evidenceRefs: [] }],
      pendingProposalCount: 0,
    },
  };
  let after = { ...before };
  if (after.value.resolution.state !== 'fresh') throw new Error('Expected fresh fixture');
  const resolution = after.value.resolution;
  const original = before.value.resolution.snapshot.candidates[0].profile;
  after = {
    ...after,
    value: {
      ...after.value,
      resolution: {
        ...resolution,
        snapshot: {
          ...resolution.snapshot,
          candidates: resolution.snapshot.candidates.map((entry, index) =>
            index === 0
              ? {
                  ...entry,
                  profile: {
                    ...original,
                    revision: {
                      ...original.revision,
                      relevantSignals: [{ kind: 'strength', summary: 'after', evidenceRefs: [] }],
                    },
                  },
                }
              : entry,
          ),
        },
      },
    },
  };
  return { before, after, rows: 'value.resolution.snapshot.candidates', id: 'codex-sol', expected: 'after' };
}
function signals() {
  const article = (id: string, title: string) => ({
    id,
    title,
    url: 'https://example.test',
    source: 'source',
    tier: 1,
    status: 'inbox',
    tags: [],
    publishedAt: '2026-01-01',
    fetchedAt: '2026-01-01',
  });
  const before = {
    ...ownerData().signals,
    read: { ...ownerData().signals.read, load: '', articles: [article('a', 'before'), article('b', 'keep')] },
  };
  let after = { ...before };
  after = {
    ...after,
    read: {
      ...after.read,
      articles: after.read.articles.map((entry, index) =>
        index === 0 ? { ...after.read.articles[0], title: 'after' } : entry,
      ),
    },
  };
  return { before, after, rows: 'read.articles', id: 'a', expected: 'after' };
}
function evolution() {
  const a = programFixture(),
    b = programFixture();
  a.program.displayName = 'before';
  b.program.programId = 'b';
  const before = { ...ownerData().evolution, query: { programs: [a, b], loading: false, error: null, rejected: null } };
  let after = { ...before };
  after = {
    ...after,
    query: {
      ...after.query,
      programs: after.query.programs.map((entry, index) =>
        index === 0
          ? { ...after.query.programs[0], program: { ...after.query.programs[0].program, displayName: 'after' } }
          : entry,
      ),
    },
  };
  return { before, after, rows: 'query.programs', id: a.program.programId, expected: 'after' };
}
function ops() {
  const key = JSON.stringify(['daemon', 'overview', 'all', '', '', 7, data.threadId, undefined, 'chat', 1]);
  const before = {
    ...ownerData().ops,
    read: {
      key,
      load: '',
      value: {
        daemon: [
          { daemonShortId: 'a', cwd: 'before', state: 'working' },
          { daemonShortId: 'b', cwd: 'keep', state: 'done' },
        ],
      },
    },
  };
  let after = { ...before };
  after = {
    ...after,
    read: {
      ...after.read,
      value: {
        ...after.read.value,
        daemon: after.read.value.daemon.map((entry, index) =>
          index === 0 ? { ...after.read.value.daemon[0], cwd: 'after' } : entry,
        ),
      },
    },
  };
  return { before, after, rows: 'read.value.daemon', id: 'a', expected: 'after' };
}
function evaluation() {
  const domain = (domainId: string, displayName: string) => ({
    domainId,
    displayName,
    evalCatId: 'codex',
    enabled: true,
    frequency: 'daily',
  });
  const before = {
    load: '',
    value: {
      summary: { counts: { stale: 0 }, domains: [domain('a', 'before'), domain('b', 'keep')], items: [] },
      cats: [],
      duty: null,
      paw: { bundles: [], bundleCounts: { total: 0 } },
    },
  };
  let after = { ...before };
  after = {
    ...after,
    value: {
      ...after.value,
      summary: {
        ...after.value.summary,
        domains: after.value.summary.domains.map((entry, index) =>
          index === 0 ? { ...after.value.summary.domains[0], displayName: 'after' } : entry,
        ),
      },
    },
  };
  return { before, after, rows: 'value.summary.domains', id: 'a', expected: 'after' };
}
function voice() {
  const service = (id: string, name: string) => ({
    id,
    name,
    description: '',
    category: 'voice',
    endpoint: null,
    configured: true,
    status: 'healthy',
    features: ['voice-input'],
    installed: true,
    enabled: true,
    installable: true,
  });
  const before = {
    ...ownerData().voice,
    services: { load: '', items: [service('a', 'before'), service('b', 'keep')] },
  };
  let after = { ...before };
  after = {
    ...after,
    services: {
      ...after.services,
      items: after.services.items.map((entry, index) =>
        index === 0 ? { ...after.services.items[0], name: 'after' } : entry,
      ),
    },
  };
  return { before, after, rows: 'services.items', id: 'a', expected: 'after' };
}
function desktop() {
  const before = { ...ownerData().desktop, available: true, currentVersion: 'before' };
  return {
    before,
    after: { ...before, currentVersion: 'after' },
    rows: '',
    field: 'desktop.currentVersion',
    expected: 'after',
  };
}
function sources() {
  const card = (id: string, query: string) => ({ blockId: id, view: { response: { query, results: [] } } });
  const before = {
    ...ownerData().sources,
    records: { ...ownerData().sources.records, evidence: { a: card('a', 'before'), b: card('b', 'keep') } },
  };
  let after = { ...before };
  after = {
    ...after,
    records: {
      ...after.records,
      evidence: {
        ...after.records.evidence,
        a: {
          ...after.records.evidence.a,
          view: {
            ...after.records.evidence.a.view,
            response: { ...after.records.evidence.a.view.response, query: 'after' },
          },
        },
      },
    },
  };
  return { before, after, rows: 'records.evidence', id: 'a', expected: 'after' };
}
function general() {
  const before = { ...ownerData().general, snapshot: { effective: 'next_work' } };
  return {
    before,
    after: { ...before, snapshot: { effective: 'continue_current' } },
    rows: '',
    field: 'general.snapshot.effective',
    expected: 'current',
  };
}
function memory() {
  const before = {
    ...ownerData().memory,
    reads: {
      ...ownerData().memory.reads,
      profile: {
        loading: false,
        error: false,
        data: {
          entries: [
            { id: 'a', title: 'before' },
            { id: 'b', title: 'keep' },
          ],
        },
      },
    },
  };
  let after = { ...before };
  after = {
    ...after,
    reads: {
      ...after.reads,
      profile: {
        ...after.reads.profile,
        data: {
          ...after.reads.profile.data,
          entries: after.reads.profile.data.entries.map((entry, index) =>
            index === 0 ? { ...after.reads.profile.data.entries[0], title: 'after' } : entry,
          ),
        },
      },
    },
  };
  return { before, after, rows: 'reads.profile.data.entries', id: 'a', expected: 'after' };
}
function memoryExplore() {
  const before = {
    ...ownerData().memory,
    explore: {
      ...ownerData().memory.explore,
      reads: {
        ...ownerData().memory.explore.reads,
        catalog: {
          loading: false,
          error: false,
          data: {
            collections: [
              { id: 'a', name: 'before' },
              { id: 'b', name: 'keep' },
            ],
            defaultTargetCollectionId: 'a',
          },
        },
      },
    },
  };
  let after = { ...before };
  after = {
    ...after,
    explore: {
      ...after.explore,
      reads: {
        ...after.explore.reads,
        catalog: {
          ...after.explore.reads.catalog,
          data: {
            ...after.explore.reads.catalog.data,
            collections: after.explore.reads.catalog.data.collections.map((entry, index) =>
              index === 0 ? { ...after.explore.reads.catalog.data.collections[0], name: 'after' } : entry,
            ),
          },
        },
      },
    },
  };
  return { before, after, rows: 'explore.reads.catalog.data.collections', id: 'a', expected: 'after' };
}
function trash() {
  const before = {
    ...ownerData().trash,
    threads: [
      { id: 'a', title: 'before', deletedAt: 1 },
      { id: 'b', title: 'keep', deletedAt: 1 },
    ],
  };
  let after = { ...before };
  after = {
    ...after,
    threads: after.threads.map((entry, index) => (index === 0 ? { ...after.threads[0], title: 'after' } : entry)),
  };
  return { before, after, rows: 'threads', id: 'a', expected: 'after' };
}
const owners = {
  team,
  signals,
  evolution,
  ops,
  evaluation,
  voice,
  desktop,
  sources,
  general,
  memory,
  memoryExplore,
  trash,
};
describe.each(Object.entries(owners))('%s held owner receipt', (name, receipt) => {
  it('treats an unchanged push as a no-op, diffs the changed record, and never reads host models', () => {
    const { before, after, rows, expected, ...delta } = receipt();
    const context = ownerConsole({ ...ui }, data),
      owner = name === 'memoryExplore' ? 'memory' : name;
    context.CS.m.cat = 'profile';
    context.CS.m.view = name === 'memoryExplore' ? 'library' : 'all';
    context.render = vi.fn();
    context.chatPort = {
      models: vi.fn(() => {
        throw new Error('Host models must not be read');
      }),
    };
    context.pushProjectData({ [owner]: before });
    const held = context.chatDataSnapshot.project,
      first = held[owner],
      read = () => context['project' + ownerFunctions[name as keyof typeof ownerFunctions]]();
    const view = JSON.stringify(read());
    const heldRows = () => new Script('chatDataSnapshot.project.' + owner + '.' + rows).runInContext(context);
    const kept = rows ? (Array.isArray(heldRows()) ? heldRows()[1] : heldRows().b) : null;
    context.render.mockClear();
    expect(context.pushProjectData({ [owner]: before })[owner]).toEqual({
      added: [],
      changed: [],
      removed: [],
      orderChanged: false,
      fields: [],
    });
    expect(context.chatDataSnapshot.project).toBe(held);
    expect(context.chatDataSnapshot.project[owner]).toBe(first);
    for (let i = 0; i < 100; i++) expect(JSON.stringify(read())).toBe(view);
    expect(context.render).not.toHaveBeenCalled();
    expect(context.chatPort.models).not.toHaveBeenCalled();
    const diff = context.pushProjectData({ [owner]: after })[owner];
    expect(diff).toEqual({
      added: [],
      changed: 'id' in delta ? [delta.id] : [],
      removed: [],
      orderChanged: false,
      fields: 'field' in delta ? [delta.field] : [],
    });
    if (rows) expect(Array.isArray(heldRows()) ? heldRows()[1] : heldRows().b).toBe(kept);
    expect(context.render).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(read())).toContain(expected);
    expect(context.chatPort.models).not.toHaveBeenCalled();
  });
});
it('switches evolution list and details directly from held programs and never reuses another program receipt', () => {
  const state = { ...ui, evoId: null as string | null },
    context = ownerConsole(state, data);
  const a = programFixture(),
    b = programFixture();
  b.program.programId = 'program-b';
  b.program.displayName = 'Program B';
  const raw = {
    ...ownerData().evolution,
    query: { programs: [a, b], loading: false, error: null, rejected: null },
    exact: { id: a.program.programId, projection: a, loading: false, error: null },
    assets: { programId: a.program.programId, loading: false, error: null },
  };
  context.chatPort = {
    models: vi.fn(() => {
      throw new Error('No owner pull');
    }),
  };
  context.pushProjectData({ evolution: raw });
  state.evoId = a.program.programId;
  expect(context.projectEvolution().evolutionOwner.program.programId).toBe(a.program.programId);
  state.evoId = null;
  expect(context.projectEvolution().cafeWsEvo.active.map((p: { id: string }) => p.id)).toContain(a.program.programId);
  state.evoId = b.program.programId;
  expect(context.projectEvolution().evolutionOwner.program.displayName).toBe('Program B');
  expect(context.projectEvolution().evolutionAssets.catalog).toBeUndefined();
  expect(context.projectEvolution().evolutionExploration).toBeNull();
  expect(context.projectEvolution().cafeWsEvo.load).toBe('');
  expect(context.chatPort.models).not.toHaveBeenCalled();
});
it.each([
  'general',
  'sources',
  'desktop',
  'trash',
])('publishes %s read errors on receipt and ignores the unchanged error source', (owner) => {
  const context = ownerConsole(),
    value = ownerData()[owner as keyof ReturnType<typeof ownerData>];
  context.dataError = vi.fn();
  context.render = vi.fn();
  const failure = new Error('Owner unavailable');
  context.pushProjectData({ [owner]: { ...value, error: failure } });
  expect(context.dataError).toHaveBeenCalledTimes(1);
  context.render.mockClear();
  expect(context.pushProjectData({ [owner]: { ...value, error: failure } })[owner]).toEqual({
    added: [],
    changed: [],
    removed: [],
    orderChanged: false,
    fields: [],
  });
  expect(context.dataError).toHaveBeenCalledTimes(1);
  expect(context.render).not.toHaveBeenCalled();
});

it('holds chat placement records by message id in the same receiver as the W3 owners', () => {
  const context = ownerConsole();
  context.render = vi.fn();
  context.pushProjectData({
    ...ownerData(),
    chatOwners: {
      proposals: {
        first: { load: '', value: { issue: { status: 'draft' } } },
        second: { load: '', value: { offer: null } },
      },
    },
  });
  const previous = context.chatDataSnapshot.project;
  context.render.mockClear();
  expect(context.pushProjectData({ chatOwners: previous.chatOwners }).chatOwners).toEqual({
    added: [],
    changed: [],
    removed: [],
    orderChanged: false,
    fields: [],
  });
  expect(context.render).not.toHaveBeenCalled();
  const diff = context.pushProjectData({
    chatOwners: {
      proposals: {
        ...previous.chatOwners.proposals,
        first: { load: '', value: { issue: { status: 'confirmed' } } },
      },
    },
  }).chatOwners;
  expect(diff).toEqual({ added: [], changed: ['first'], removed: [], orderChanged: false, fields: [] });
  expect(context.chatDataSnapshot.project.chatOwners.proposals.second).toBe(previous.chatOwners.proposals.second);
  expect(context.chatDataSnapshot.project.evaluation).toBe(previous.evaluation);
  expect(context.render).toHaveBeenCalledTimes(1);
});

it('keeps the source disposition filter and error in the held evaluation projection and can restore all bundles', () => {
  const state = { ...ui, evalView: 'events', pawSource: null as object | null },
    context = ownerConsole(state);
  const bundle = (id: string) => ({
    bundleKey: id,
    basis: 'message',
    sourceThreadId: 'pdl-test',
    rawSignalCount: 1,
    issue: { resolution: 'open', ageMs: 100, continuation: { kind: 'review_required' } },
    responsibility: { state: 'unreviewed', validExit: false },
    members: [
      {
        disposition: { sourceCatId: 'codex', sourceMessageId: id, discoveredAt: '2026-01-01' },
        source: { availability: 'available', preview: id },
        issue: { ageMs: 100 },
      },
    ],
  });
  const a = bundle('first'),
    b = bundle('second');
  context.chatPort = {
    models: vi.fn(() => {
      throw new Error('No owner pull');
    }),
  };
  context.pushProjectData({
    evaluation: {
      load: '',
      value: {
        summary: { counts: { stale: 0 }, domains: [], items: [] },
        cats: [],
        duty: null,
        paw: { bundles: [a, b], bundleCounts: { total: 2 } },
      },
    },
  });
  state.pawSource = { messageId: 'second', page: { bundles: [b] } };
  expect(context.projectEvaluation().eval.paw).toMatchObject({
    source: 'second',
    counts: { all: 1 },
    items: [{ key: 'second' }],
  });
  state.pawSource = { messageId: 'second', page: { error: 'Source unavailable' } };
  expect(context.projectEvaluation().eval.paw).toMatchObject({
    source: 'second',
    error: 'Source unavailable',
    items: [],
    counts: { all: 0 },
  });
  state.pawSource = null;
  expect(context.projectEvaluation().eval.paw.counts.all).toBe(2);
  expect(context.projectEvaluation().eval.paw.items).toHaveLength(2);
  expect(context.chatPort.models).not.toHaveBeenCalled();
});

it('retains candidate ids and undo capability in the held library projection alongside offset pages', () => {
  const context = ownerConsole();
  context.CS.m.view = 'library';
  context.CS.m.lib = 'done';
  const memory = ownerData().memory;
  context.chatPort = {
    models: vi.fn(() => {
      throw new Error('No owner pull');
    }),
  };
  context.pushProjectData({
    memory: {
      ...memory,
      explore: {
        ...memory.explore,
        reads: {
          ...memory.explore.reads,
          feed: {
            loading: false,
            error: false,
            data: {
              pending: [],
              processed: [
                { id: 'approved', content: 'Approved item', state: 'approved' },
                { id: 'rejected', content: 'Rejected item', state: 'rejected' },
              ],
            },
          },
        },
      },
    },
  });
  expect(context.projectMemory().cafeMemory.library.done).toMatchObject([
    { id: 'approved', canUndo: true },
    { id: 'rejected', canUndo: false },
  ]);
  expect(context.chatPort.models).not.toHaveBeenCalled();
});

it('diffs a full unified inbox receipt by its real decisionRef and retains unchanged rows after movement', () => {
  const console = createOwnerConsole();
  const before = [
    { decisionRef: 'same', kind: 'user_mention', summary: 'same' },
    { decisionRef: 'removed', kind: 'repair', summary: 'removed' },
    { decisionRef: 'changing', kind: 'approval', summary: 'pending' },
  ];
  console.context.__before = before;
  console.read(
    "var __diff={added:[],removed:[],changed:[],orderChanged:false,fields:[]}; var __held=receiveProjectValue(null,__before,'inbox.items',__diff)",
  );
  const held = console.read('__held');
  console.context.__next = JSON.parse(
    JSON.stringify([
      before[0],
      { ...before[2], summary: 'completed' },
      { decisionRef: 'added', kind: 'repair', summary: 'new' },
    ]),
  );
  console.read(
    "__diff={added:[],removed:[],changed:[],orderChanged:false,fields:[]}; __held=receiveProjectValue(__held,__next,'inbox.items',__diff)",
  );
  expect(console.read('__diff')).toMatchObject({ added: ['added'], removed: ['removed'], changed: ['changing'] });
  expect(console.read('__held')[0]).toBe(held[0]);
});
