import type {
  EntityMemoryProposalView,
  PersonMemoryProposalView,
  ProfileMemoryProposalView,
  ProfileUsageSummary,
} from '@cat-cafe/shared';
import { readProfileOpeningReference, updateProfileOpeningReference } from '@cat-cafe/shared/profile-opening-reference';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useMemoryBindings } from '../useMemoryBindings';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const person = {
  personId: 'person',
  displayName: 'Recorded person',
  aliases: [],
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  currentClaimCount: 0,
  activeInteractionCount: 1,
};
const interaction = {
  eventId: 'interaction',
  revision: 'interaction-r0',
  eventKind: 'conversation',
  headline: 'Original headline',
  importanceOrTopic: 'Original topic',
  uncertaintyNotes: ['Not confirmed'],
  status: 'active',
  recordedAt: 1,
  sourceCount: 0,
};
const prefix = '---\r\nrelationship: exact-byte-owner\r\n---\r\n';
let profile: {
  id: string;
  revision: string;
  content: string;
  title: string;
  type: string;
  status: string;
  layer: string;
  relationshipKey: null;
  uri: string;
  proposals: [];
};
let writes: Record<string, unknown>[], fail: boolean, pages: number[];
let sourceRead: unknown, usageRead: unknown;
beforeEach(() => {
  writes = [];
  fail = false;
  pages = [];
  sourceRead = { status: 'not_recorded', sources: [] };
  usageRead = {
    memoryId: 'profile',
    revision: 'profile-r0',
    openingMode: 'enabled',
    historyComplete: false,
    directReadRecordedSince: 1,
    earliestRecordedAt: null,
    currentVersion: { opening: 1, read: 2 },
    allVersions: { opening: 1, read: 2 },
    recent: [],
  } satisfies ProfileUsageSummary;
  profile = {
    id: 'profile',
    revision: 'profile-r0',
    content: prefix + 'Original body',
    title: 'Profile',
    type: 'profile',
    status: 'active',
    layer: 'primer',
    relationshipKey: null,
    uri: 'profile://owner',
    proposals: [],
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const url = new URL(String(path), 'https://api.test');
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (fail) {
        fail = false;
        return response({ error: 'unknown_result' }, 503);
      }
      if (body.action === 'replace_content') {
        profile = { ...profile, content: body.content, revision: 'profile-r1' };
        return response({ action: body.action, outcome: 'applied', revision: profile.revision });
      }
      return response({ action: body.action, outcome: 'applied' });
    }
    if (url.pathname === '/api/memory/people') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      pages.push(offset);
      return response({
        readStatus: 'ready',
        entries: [{ ...person, personId: 'person-' + offset }],
        meta: { count: 1, limit: 20, offset, hasMore: offset < 2, nextOffset: offset < 2 ? offset + 1 : undefined },
      });
    }
    if (url.pathname === '/api/memory/people/person')
      return response({
        ...person,
        personRevision: 'person-r0',
        sourceCount: 0,
        claims: [],
        relationships: [],
        interactions: [interaction],
        truncation: { claims: false, relationships: false, interactions: false },
      });
    if (url.pathname === '/api/memory/profile') return response({ readStatus: 'ready', entries: [profile] });
    if (url.pathname === '/api/memory/profile/profile') {
      expect(url.searchParams.get('revision')).toBe(profile.revision);
      return response(profile);
    }
    if (url.pathname.endsWith('/usage')) return response(usageRead);
    if (url.pathname.endsWith('/source')) return response(sourceRead);
    if (url.pathname === '/api/memory/taste') return response({ readStatus: 'ready', entries: [], coverage: null });
    if (url.pathname === '/api/memory/entities') return response({ readStatus: 'ready', entries: [] });
    if (url.pathname === '/api/memory/events')
      return response({ events: [], meta: { count: 0, offset: 0, hasMore: false } });
    throw new Error('Unexpected memory owner ' + path);
  });
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const ready = async () => {
  const hook = renderHook(() => useMemoryBindings(() => true));
  await waitFor(() =>
    expect(projectOwner('memory', hook.result.current, {}, undefined, undefined).cafeMemory.all.load).toBe(''),
  );
  return hook;
};

it('r3b36 opens the searched graph anchor in its actual collection without resolving a demo query', async () => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  const graph = { center: 'actual-anchor', nodes: [], edges: [] };
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const url = new URL(String(path), 'https://api.test');
    if (url.pathname === '/api/memory/search')
      return response({
        query: 'Needle',
        readStatus: 'ready',
        groups: [
          {
            type: 'documents',
            status: 'ready',
            hasMore: false,
            results: [
              {
                id: 'result',
                title: 'Real document',
                snippet: 'Actual source',
                displayType: 'document',
                authority: null,
                updatedAt: null,
                destination: { kind: 'document', collection: 'actual-collection', anchor: 'actual-anchor' },
                graph: { collection: 'actual-collection', anchor: 'actual-anchor' },
              },
            ],
          },
        ],
      });
    if (url.pathname === '/api/library/graph') return response(graph);
    return original(path, init);
  });
  const hook = await ready();
  await act(async () => {
    Object.assign(hook.result.current.state, { view: 'search', searched: 'Needle' });
    await hook.result.current.action('memoryBrowse', {});
  });
  await waitFor(() => expect(hook.result.current.data.explore.search.data?.query).toBe('Needle'));
  await act(async () => {
    Object.assign(hook.result.current.state, { view: 'graph', node: '["actual-collection","actual-anchor"]' });
    await hook.result.current.action('memoryGraphNode', {});
  });
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/library/graph?anchor=actual-anchor&collection=actual-collection&depth=1',
    undefined,
    undefined,
  );
  expect(hook.result.current.data.explore.graph).toEqual({ status: 'graph', graph });
  expect(hook.result.current.state.node).toBe('actual-anchor');
});
it.each([
  [
    'personClaimSave',
    {
      personId: 'person',
      claimId: 'claim',
      expectedRevision: 'claim-r0',
      payload: { kind: 'user_assessment', statement: 'Corrected', stance: 'endorsed' },
    },
    'correct_claim',
  ],
  [
    'personEventSave',
    {
      personId: 'person',
      eventId: 'interaction',
      expectedRevision: 'interaction-r0',
      payload: { eventKind: 'conversation', headline: 'Amended' },
    },
    'amend_event',
  ],
  [
    'profileSave',
    { id: 'profile', kind: 'profile', expectedRevision: 'profile-r0', content: prefix + 'Saved' },
    'replace_content',
  ],
  [
    'memoryRecordSave',
    { family: 'entity', id: 'entity', expectedRevision: 'entity-r0', patch: { canonicalName: 'Corrected' } },
    'correct',
  ],
  ['personForget', { personId: 'person', expectedPersonRevision: 'person-r0', confirmed: true }, 'hard_forget_person'],
] as const)('writes %s through the exact native owner with its original revision and payload', async (name, args, operation) => {
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, ...rest) =>
    /^\/api\/memory\/entities\/entity(?:\?|$)/.test(String(path)) && !rest[0]?.method
      ? response({
          id: 'entity',
          revision: 'entity-r1',
          canonicalName: 'Corrected',
          aliases: [],
          stance: 'endorsed',
          status: 'active',
          proposals: [],
        })
      : original(path, ...rest),
  );
  const hook = await ready();
  await act(() => hook.result.current.action(name, args as unknown as Record<string, string>));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { family: _family, id: _id, kind: _kind, personId: _personId, ...body } = args as Record<string, unknown>;
  expect(writes[0]).toMatchObject({ action: operation, ...body, requestId: expect.any(String) });
  const family = name.startsWith('person')
    ? 'people/person'
    : name === 'profileSave'
      ? 'profile/profile'
      : 'entities/entity';
  expect(apiFetch).toHaveBeenCalledWith(
    `/api/memory/${family}/actions`,
    expect.objectContaining({ method: 'POST' }),
    undefined,
  );
});
it('edits and cancels the structured opening reference through replace_content while preserving its source and profile body', async () => {
  const opening = {
    asOf: '2026-11-03',
    excerpts: [
      {
        kind: 'relationship' as const,
        text: 'Original relationship',
        source: { threadId: 'source-thread', messageId: 'source-message' },
      },
      {
        kind: 'model_capability' as const,
        model: 'Owner model',
        text: 'Original capability',
        source: { threadId: 'source-thread', messageId: 'capability-message' },
      },
    ],
  };
  profile.content = updateProfileOpeningReference(profile.content, opening)!;
  const hook = await ready();
  await act(() =>
    hook.result.current.action('memoryOpen', { family: 'profile', id: 'profile', revision: 'profile-r0' }),
  );
  const detail = projectOwner('memory', hook.result.current, {}).cafeMemory.detail!;
  expect(detail).toHaveProperty('profile.openingReference', opening);
  await act(() =>
    hook.result.current.action('profileOpening', {
      op: 'edit',
      id: 'profile',
      expectedRevision: 'profile-r0',
      asOf: '2026-11-04',
      texts: ['Updated relationship', 'Updated capability'] as unknown as string,
    }),
  );
  expect(writes[0]).toMatchObject({ action: 'replace_content', expectedRevision: 'profile-r0' });
  expect(readProfileOpeningReference(profile.content)).toEqual({
    ...opening,
    asOf: '2026-11-04',
    excerpts: opening.excerpts.map((entry, i) => ({
      ...entry,
      text: ['Updated relationship', 'Updated capability'][i],
    })),
  });
  expect(profile.content).toContain('relationship: exact-byte-owner');
  expect(profile.content).toContain('Original body');
  await act(() =>
    hook.result.current.action('profileOpening', { op: 'cancel', id: 'profile', expectedRevision: 'profile-r1' }),
  );
  expect(readProfileOpeningReference(profile.content)).toBeNull();
  expect(profile.content).toContain('Original body');
  const cancelled = projectOwner('memory', hook.result.current, {}).cafeMemory.detail!;
  expect(cancelled).toHaveProperty('profile.openingReference', null);
});
it('rejects invalid or stale opening edits before writing to the profile owner', async () => {
  profile.content = updateProfileOpeningReference(profile.content, {
    asOf: '2026-11-03',
    excerpts: [{ kind: 'relationship', text: 'Original', source: { threadId: 'thread', messageId: 'message' } }],
  })!;
  const hook = await ready();
  await act(() =>
    hook.result.current.action('memoryOpen', { family: 'profile', id: 'profile', revision: 'profile-r0' }),
  );
  await expect(
    hook.result.current.action('profileOpening', {
      op: 'edit',
      id: 'profile',
      expectedRevision: 'profile-r0',
      asOf: '2026-02-30',
      texts: ['Updated'] as unknown as string,
    }),
  ).rejects.toThrow('memoryOwners.opening.invalid');
  await expect(
    hook.result.current.action('profileOpening', { op: 'cancel', id: 'other-profile', expectedRevision: 'profile-r0' }),
  ).rejects.toThrow();
  expect(writes).toEqual([]);
});
it.each([
  'enabled',
  'on_demand',
] as const)('projects the actual %s opening mode and stable owner usage records without changing it', async (openingMode) => {
  const usage: ProfileUsageSummary = {
    memoryId: 'profile',
    revision: 'profile-r0',
    openingMode,
    historyComplete: false,
    directReadRecordedSince: 1,
    earliestRecordedAt: null,
    currentVersion: { opening: 0, read: 1 },
    allVersions: { opening: 5, read: 2 },
    recent: [
      {
        eventId: 'usage-owner',
        kind: 'read',
        occurredAt: 1,
        sourceRevision: 'profile-r0',
        catId: 'codex',
        threadId: 'usage-thread',
      },
    ],
  };
  usageRead = usage;
  const hook = await ready();
  await act(() =>
    hook.result.current.action('memoryOpen', { family: 'profile', id: 'profile', revision: 'profile-r0' }),
  );
  expect(projectOwner('memory', hook.result.current, {}).cafeMemory.detail).toMatchObject({
    profile: {
      usage: expect.objectContaining(usage),
      usageRows: usage.recent,
    },
  });
  expect(writes).toEqual([]);
});
it.each([
  'profile',
  'entity',
  'person',
] as const)('opens the exact published approval from the %s owner without issuing a decision', async (family) => {
  const origin = {
    proposalId: 'proposal-owner',
    sourceCatId: 'codex',
    sourceThreadId: 'draft-thread',
    createdAt: 1,
    approvalState: 'anchored' as const,
    approvalCardRef: { threadId: 'approval-thread', messageId: 'approval-mid' },
  };
  const proposals = {
    profile: {
      ...origin,
      status: 'pending',
      rationale: 'Profile owner rationale',
      suggestedContent: 'Pending profile text',
      expectedRevision: `sha256:${'a'.repeat(64)}`,
      decisionEndpointBase: '/api/profile-updates',
    } satisfies ProfileMemoryProposalView,
    entity: {
      ...origin,
      status: 'pending',
      rationale: 'Entity owner rationale',
      suggestedPatch: {
        entityType: 'concept',
        canonicalName: 'Owner name',
        aliases: [],
        stance: 'neutral',
        visibilityScope: 'private',
      },
      decisionEndpointBase: '/api/entity-proposals',
    } satisfies EntityMemoryProposalView,
    person: {
      ...origin,
      status: 'pending_approval',
      displayName: 'Person owner name',
      remainingDraftIds: ['remaining-owner-draft'],
      decisionEndpointBase: '/api/person-memory-proposals',
    } satisfies PersonMemoryProposalView,
  };
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const pathname = new URL(String(path), 'https://api.test').pathname;
    if (family !== 'person' && pathname === `/api/memory/${family === 'entity' ? 'entities' : 'profile'}/${family}`) {
      const detail =
        family === 'profile'
          ? profile
          : {
              id: 'entity',
              revision: 'entity-r0',
              type: 'entity',
              entityType: 'concept',
              canonicalName: 'Owner entity',
              aliases: [],
              stance: 'neutral',
              visibilityScope: 'private',
              updatedAt: '2026-11-03',
              provenanceCount: 0,
              status: 'active',
              provenance: [],
            };
      return response({ ...detail, proposals: [proposals[family]] });
    }
    if (family === 'person' && pathname === '/api/memory/people/person') {
      return response({ ...(await (await read(path, init)).json()), proposals: [proposals.person] });
    }
    return read(path, init);
  });
  const hook = await ready();
  await act(() => hook.result.current.action('memoryOpen', { family, id: family, revision: family + '-r0' }));
  expect(projectOwner('memory', hook.result.current, {}).cafeMemory.detail).toEqual(
    expect.objectContaining({
      proposals: [
        {
          id: origin.proposalId,
          title:
            family === 'person'
              ? 'Person owner name'
              : `${family === 'profile' ? 'Profile' : 'Entity'} owner rationale`,
          state: proposals[family].status,
          act: 'msgJump',
          args: { t: 'approval-thread', mid: 'approval-mid' },
        },
      ],
    }),
  );
  expect(writes).toEqual([]);
});

it.each([
  'staged',
  'tombstoned',
  'legacy_unanchored',
  'missing-ref',
] as const)('keeps %s profile proposals readable without a fabricated approval link', async (publication) => {
  const read = vi.mocked(apiFetch).getMockImplementation()!;
  const proposal: ProfileMemoryProposalView = {
    proposalId: 'proposal-owner',
    status: 'pending',
    rationale: 'Owner rationale',
    suggestedContent: 'Pending text',
    expectedRevision: `sha256:${'a'.repeat(64)}`,
    sourceCatId: 'codex',
    sourceThreadId: 'draft-thread',
    createdAt: 1,
    decisionEndpointBase: '/api/profile-updates',
    approvalState: publication === 'missing-ref' ? 'anchored' : publication,
    ...(publication === 'missing-ref' ? {} : { approvalCardRef: { threadId: 'stale-thread', messageId: 'stale-mid' } }),
  };
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    new URL(String(path), 'https://api.test').pathname === '/api/memory/profile/profile'
      ? response({ ...profile, proposals: [proposal] })
      : read(path, init),
  );
  const hook = await ready();
  await act(() =>
    hook.result.current.action('memoryOpen', { family: 'profile', id: 'profile', revision: 'profile-r0' }),
  );
  expect(projectOwner('memory', hook.result.current, {}).cafeMemory.detail).toEqual(
    expect.objectContaining({
      proposals: [{ id: 'proposal-owner', title: 'Owner rationale', state: 'pending', act: '', args: {} }],
    }),
  );
  expect(writes).toEqual([]);
});

it('follows owner offsets rather than increasing the native page size beyond its maximum', async () => {
  const hook = await ready();
  await waitFor(() => expect(pages).toEqual([0, 1, 2]));
  projectOwner('memory', hook.result.current, {}).memoryState.cat = 'person';
  expect(projectOwner('memory', hook.result.current, {}).cafeMemory.all.more).toBe(false);
  expect(
    projectOwner('memory', hook.result.current, {}).cafeMemory.all.items.map((e: { key: string }) => e.key),
  ).toEqual(['person-0', 'person-1', 'person-2']);
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([p]) => String(p).startsWith('/api/memory/people?'))
      .every(([p]) => new URL(String(p), 'https://api.test').searchParams.get('limit') === '20'),
  ).toBe(true);
});

it('projects the native next-page flag and removes load-more with failed or empty data', async () => {
  const hook = await ready(),
    binding = hook.result.current,
    page = { readStatus: 'ready', entries: [person], meta: { hasMore: true } },
    state = { ...binding.state, cat: 'person' };
  const project = (data: unknown, error = false) =>
    projectOwner(
      'memory',
      {
        ...binding,
        state,
        data: { ...binding.data, reads: { ...binding.data.reads, person: { data, loading: false, error } } },
      },
      {},
    ).cafeMemory.all;
  expect(project(page)).toMatchObject({ more: true, items: [{ key: 'person' }] });
  expect(project({ ...page, meta: { hasMore: false } }).more).toBe(false);
  expect(project(null, true)).toMatchObject({ load: 'error', more: false, items: [] });
});
it('preserves profile frontmatter and retries the exact unknown mutation before rereading the returned revision', async () => {
  const hook = await ready();
  await act(() =>
    hook.result.current.action('memoryOpen', { family: 'profile', id: 'profile', revision: 'profile-r0' }),
  );
  await act(() => hook.result.current.action('cafeMemAct', { op: 'edit' }));
  expect(projectOwner('memory', hook.result.current, {}).memoryEdit?.values.content).toBe('Original body');
  fail = true;
  await act(async () => {
    await expect(
      hook.result.current.action('memoryEditSave', { values: JSON.stringify({ content: 'Changed body' }) }),
    ).rejects.toThrow('unknown_result');
  });
  await act(() =>
    hook.result.current.action('memoryEditSave', { values: JSON.stringify({ content: 'Changed body' }) }),
  );
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]).toMatchObject({
    action: 'replace_content',
    expectedRevision: 'profile-r0',
    content: prefix + 'Changed body',
  });
  expect(projectOwner('memory', hook.result.current, {}).memoryDetail?.entry.revision).toBe('profile-r1');
});
it('keeps interaction uncertainty notes and its own revision when amending an event', async () => {
  const hook = await ready();
  await act(() => hook.result.current.action('memoryOpen', { family: 'person', id: 'person' }));
  expect(projectOwner('memory', hook.result.current, {}).memoryDetail?.entry.revision).toBe('person-r0');
  await act(() => hook.result.current.action('cafeMemAct', { op: 'event', id: 'interaction' }));
  expect(projectOwner('memory', hook.result.current, {}).memoryEdit?.values.notes).toEqual(['Not confirmed']);
  await act(() =>
    hook.result.current.action('memoryEditSave', {
      values: JSON.stringify({ headline: 'Corrected headline', topic: 'Original topic', notes: 'Not confirmed' }),
    }),
  );
  expect(writes[0]).toMatchObject({
    action: 'amend_event',
    eventId: 'interaction',
    expectedRevision: 'interaction-r0',
    payload: { headline: 'Corrected headline', uncertaintyNotes: ['Not confirmed'] },
  });
});
it('keeps nullable source time and private usage thread identity out of dates and navigation', async () => {
  sourceRead = {
    status: 'ready',
    sources: [{ kind: 'message', label: 'Owner source', occurredAt: null, canOpen: false }],
  };
  usageRead = {
    memoryId: 'profile',
    revision: 'profile-r0',
    openingMode: 'enabled',
    historyComplete: false,
    directReadRecordedSince: 1,
    earliestRecordedAt: null,
    currentVersion: { opening: 0, read: 1 },
    allVersions: { opening: 0, read: 1 },
    recent: [
      { eventId: 'usage', kind: 'read', occurredAt: 1, sourceRevision: 'profile-r0', catId: 'codex', threadId: null },
    ],
  };
  const hook = await ready();
  await act(() =>
    hook.result.current.action('memoryOpen', { family: 'profile', id: 'profile', revision: 'profile-r0' }),
  );
  expect(projectOwner('memory', hook.result.current, {}).cafeMemory.detail).toMatchObject({
    sources: [{ title: 'Owner source', time: null, act: '' }],
    profile: { usageRows: [{ kind: 'read', threadId: null }] },
  });
  sourceRead = {
    status: 'ready',
    sources: [
      { kind: 'message', title: null, threadId: 'untitled-owner-thread', messageId: 'owner-message', canOpen: true },
    ],
  };
  await act(() => hook.result.current.action('memoryOpen', { family: 'person', id: 'person' }));
  expect(projectOwner('memory', hook.result.current, {}).cafeMemory.detail).toMatchObject({
    person: {
      interactions: [
        {
          sources: [
            {
              title: 'untitled-owner-thread',
              time: undefined,
              act: 'msgJump',
              args: { t: 'untitled-owner-thread', mid: 'owner-message' },
            },
          ],
        },
      ],
    },
  });
});

it('undoes a knowledge candidate through its marker owner and refreshes the library feed', async () => {
  const hook = renderHook(() => useMemoryBindings(() => true));
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/memory/library-feed'));
  const before = vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/memory/library-feed').length;
  await act(() => hook.result.current.action('cafeCandUndo', { id: 'marker-1' }));
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/knowledge/undo',
    expect.objectContaining({ method: 'POST', body: '{"markerId":"marker-1"}' }),
    undefined,
  );
  await waitFor(() =>
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/api/memory/library-feed').length,
    ).toBeGreaterThan(before),
  );
});
