import type { BacklogLease, CatId, MissionHubSelfClaimScope, ThreadPhase } from '@cat-cafe/shared';

export interface MutableBacklogSuggestion {
  catId: CatId;
  why: string;
  plan: string;
  requestedPhase: ThreadPhase;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: number;
  decidedAt?: number;
  decidedBy?: string;
  note?: string;
}

export interface MutableBacklogAuditEntry {
  id: string;
  action:
    | 'created'
    | 'refreshed'
    | 'suggested'
    | 'approved'
    | 'rejected'
    | 'dispatched'
    | 'lease_acquired'
    | 'lease_heartbeat'
    | 'lease_released'
    | 'lease_reclaimed';
  actor: { kind: 'cat' | 'user'; id: string };
  timestamp: number;
  detail?: string;
}

export interface MutableBacklogItem {
  id: string;
  userId: string;
  title: string;
  summary: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  tags: string[];
  status: 'open' | 'suggested' | 'approved' | 'dispatched' | 'done';
  createdBy: 'user' | CatId;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  dispatchedAt?: number;
  audit: MutableBacklogAuditEntry[];
  suggestion?: MutableBacklogSuggestion;
  lease?: BacklogLease;
  dispatchedThreadId?: string;
  dispatchedThreadPhase?: ThreadPhase;
  doneAt?: number;
  dependencies?: { evolvedFrom?: string[]; blockedBy?: string[]; related?: string[] };
}

export function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

export function cloneItem(item: MutableBacklogItem): MutableBacklogItem {
  return {
    ...item,
    tags: [...item.tags],
    audit: item.audit.map((entry) => ({
      ...entry,
      actor: { ...entry.actor },
    })),
    ...(item.suggestion ? { suggestion: { ...item.suggestion } } : {}),
    ...(item.lease ? { lease: { ...item.lease } } : {}),
  };
}

export function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  descriptor?.set?.call(element, value);
}

export async function flush(act: (callback: () => Promise<void>) => Promise<void>): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

interface CreateItemBody {
  title: string;
  summary: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  tags: string[];
}

interface SuggestClaimBody {
  catId: CatId;
  why: string;
  plan: string;
  requestedPhase: ThreadPhase;
}

interface DecideClaimBody {
  decision: 'approve' | 'reject';
  threadPhase?: ThreadPhase;
  note?: string;
}

interface LeaseBody {
  catId?: CatId;
  ttlMs?: number;
}

export interface MutableThreadSummary {
  id: string;
  title?: string;
  createdBy: string;
  lastActiveAt: number;
  participants: CatId[];
  backlogItemId?: string;
}

export interface MissionControlMockBackend {
  setItems(nextItems: MutableBacklogItem[]): void;
  getItems(): MutableBacklogItem[];
  setThreads(nextThreads: MutableThreadSummary[]): void;
  setSelfClaimScope(catId: CatId, scope: MissionHubSelfClaimScope): void;
  handleRequest(path: string, init?: RequestInit): Promise<Response>;
}

export function createMissionControlMockBackend(): MissionControlMockBackend {
  let items: MutableBacklogItem[] = [];
  let threads: MutableThreadSummary[] = [];
  let itemSeq = 1;
  let threadSeq = 1;
  const selfClaimScopes: Record<string, MissionHubSelfClaimScope> = {
    codex: 'disabled',
  };

  const setItems = (nextItems: MutableBacklogItem[]) => {
    items = nextItems.map((item) => cloneItem(item));
  };

  const getItems = () => items;
  const setThreads = (nextThreads: MutableThreadSummary[]) => {
    threads = nextThreads.map((thread) => ({ ...thread, participants: [...thread.participants] }));
  };
  const setSelfClaimScope = (catId: CatId, scope: MissionHubSelfClaimScope) => {
    selfClaimScopes[catId] = scope;
  };

  const handleRequest = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === '/api/cats') {
      return mockResponse(200, {
        cats: [
          {
            id: 'codex',
            displayName: '缅因猫',
            nickname: '砚砚',
            color: { primary: '#4B5563', secondary: '#E5E7EB' },
            mentionPatterns: ['@codex'],
            clientId: 'openai',
            defaultModel: 'gpt-5.3-codex',
            avatar: '/avatars/codex.png',
            roleDescription: 'review',
            personality: 'rigorous',
          },
        ],
      });
    }

    if (path === '/api/backlog/items' && (!init?.method || init.method === 'GET')) {
      return mockResponse(200, { items: items.map((item) => cloneItem(item)) });
    }

    if (path.startsWith('/api/threads') && (!init?.method || init.method === 'GET')) {
      const url = new URL(path, 'http://localhost');

      // F058 Phase G: featureIds query returns threadsByFeature grouped response
      const featureIdsCsv = url.searchParams.get('featureIds');
      if (featureIdsCsv) {
        const fids = featureIdsCsv
          .split(',')
          .map((id) => id.trim().toLowerCase())
          .filter(Boolean);
        // Enforce 50-ID limit (matching backend)
        if (fids.length > 50) return mockResponse(400, { error: 'Too many featureIds (max 50)' });
        const threadsByFeature: Record<
          string,
          Array<{ id: string; title: string | null; lastActiveAt: number; participants: string[] }>
        > = {};
        // Build fuzzy regex per feature ID (matching backend)
        const patterns = fids.map((fid) => {
          const num = Number.parseInt(fid.replace(/^f0*/, ''), 10);
          return { key: fid.toUpperCase(), re: new RegExp(`(?:f(?:eat(?:ure)?)?)\\s*0*${num}(?!\\d)`, 'i') };
        });
        for (const thread of threads) {
          const title = thread.title ?? '';
          for (const { key, re } of patterns) {
            if (re.test(title)) {
              const arr = threadsByFeature[key] ?? [];
              arr.push({
                id: thread.id,
                title: thread.title ?? null,
                lastActiveAt: thread.lastActiveAt,
                participants: [...thread.participants],
              });
              threadsByFeature[key] = arr;
            }
          }
        }
        return mockResponse(200, { threadsByFeature });
      }

      const backlogFilterCsv = url.searchParams.get('backlogItemIds');
      const backlogFilters = backlogFilterCsv
        ? new Set(
            backlogFilterCsv
              .split(',')
              .map((id) => id.trim())
              .filter((id) => id.length > 0),
          )
        : null;

      const filteredThreads = backlogFilters
        ? threads.filter((thread) => thread.backlogItemId && backlogFilters.has(thread.backlogItemId))
        : threads;

      return mockResponse(200, {
        threads: filteredThreads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          createdBy: thread.createdBy,
          lastActiveAt: thread.lastActiveAt,
          participants: [...thread.participants],
          backlogItemId: thread.backlogItemId,
        })),
      });
    }

    if (path === '/api/backlog/self-claim-policy' && (!init?.method || init.method === 'GET')) {
      return mockResponse(200, { scopes: { ...selfClaimScopes } });
    }

    if (path === '/api/backlog/items' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as CreateItemBody;
      const now = Date.now();
      const item: MutableBacklogItem = {
        id: `b-${itemSeq++}`,
        userId: 'u_test',
        title: body.title,
        summary: body.summary,
        priority: body.priority,
        tags: body.tags ?? [],
        status: 'open',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [
          {
            id: `a-${now}`,
            action: 'created',
            actor: { kind: 'user', id: 'u_test' },
            timestamp: now,
          },
        ],
      };
      items = [item, ...items];
      return mockResponse(201, item);
    }

    const suggestMatch = path.match(/^\/api\/backlog\/items\/([^/]+)\/suggest-claim$/);
    if (suggestMatch && init?.method === 'POST') {
      const id = decodeURIComponent(suggestMatch[1] ?? '');
      const body = JSON.parse(String(init.body)) as SuggestClaimBody;
      const target = items.find((item) => item.id === id);
      if (!target) return mockResponse(404, { error: 'not found' });
      const updated: MutableBacklogItem = {
        ...target,
        status: 'suggested',
        suggestion: {
          catId: body.catId,
          why: body.why,
          plan: body.plan,
          requestedPhase: body.requestedPhase,
          status: 'pending',
          suggestedAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      items = items.map((item) => (item.id === id ? updated : item));
      return mockResponse(200, cloneItem(updated));
    }

    const decideMatch = path.match(/^\/api\/backlog\/items\/([^/]+)\/decide-claim$/);
    if (decideMatch && init?.method === 'POST') {
      const id = decodeURIComponent(decideMatch[1] ?? '');
      const body = JSON.parse(String(init.body)) as DecideClaimBody;
      const target = items.find((item) => item.id === id);
      if (!target) return mockResponse(404, { error: 'not found' });

      if (body.decision === 'reject') {
        const updated: MutableBacklogItem = {
          ...target,
          status: 'open',
          suggestion: target.suggestion
            ? {
                ...target.suggestion,
                status: 'rejected',
                decidedAt: Date.now(),
                decidedBy: 'u_test',
                ...(body.note ? { note: body.note } : {}),
              }
            : undefined,
          updatedAt: Date.now(),
        };
        items = items.map((item) => (item.id === id ? updated : item));
        return mockResponse(200, { item: cloneItem(updated) });
      }

      const updated: MutableBacklogItem = {
        ...target,
        status: 'dispatched',
        dispatchedThreadId: `thread-${threadSeq++}`,
        dispatchedThreadPhase: body.threadPhase ?? 'coding',
        suggestion: target.suggestion
          ? {
              ...target.suggestion,
              status: 'approved',
              decidedAt: Date.now(),
              decidedBy: 'u_test',
            }
          : undefined,
        updatedAt: Date.now(),
      };
      items = items.map((item) => (item.id === id ? updated : item));
      return mockResponse(200, {
        item: cloneItem(updated),
        thread: { id: updated.dispatchedThreadId },
      });
    }

    const selfClaimMatch = path.match(/^\/api\/backlog\/items\/([^/]+)\/self-claim$/);
    if (selfClaimMatch && init?.method === 'POST') {
      const id = decodeURIComponent(selfClaimMatch[1] ?? '');
      const body = JSON.parse(String(init.body)) as SuggestClaimBody;
      const scope = selfClaimScopes[body.catId] ?? 'disabled';
      if (scope === 'disabled') return mockResponse(403, { error: 'Self-claim is disabled by mission hub policy' });

      const target = items.find((item) => item.id === id);
      if (!target) return mockResponse(404, { error: 'not found' });

      const updated: MutableBacklogItem = {
        ...target,
        status: 'dispatched',
        suggestion: {
          catId: body.catId,
          why: body.why,
          plan: body.plan,
          requestedPhase: body.requestedPhase,
          status: 'approved',
          suggestedAt: Date.now(),
          decidedAt: Date.now(),
          decidedBy: 'u_test',
          note: `self-claim:${body.catId}`,
        },
        dispatchedThreadId: `thread-${threadSeq++}`,
        dispatchedThreadPhase: body.requestedPhase,
        updatedAt: Date.now(),
      };
      items = items.map((item) => (item.id === id ? updated : item));
      return mockResponse(200, {
        item: cloneItem(updated),
        thread: { id: updated.dispatchedThreadId, backlogItemId: updated.id },
        selfClaimScope: scope,
      });
    }

    const leaseAcquireMatch = path.match(/^\/api\/backlog\/items\/([^/]+)\/lease\/acquire$/);
    if (leaseAcquireMatch && init?.method === 'POST') {
      const id = decodeURIComponent(leaseAcquireMatch[1] ?? '');
      const body = JSON.parse(String(init.body)) as LeaseBody;
      const target = items.find((item) => item.id === id);
      if (!target) return mockResponse(404, { error: 'not found' });
      const ttlMs = body.ttlMs ?? 60_000;
      const now = Date.now();
      const updated: MutableBacklogItem = {
        ...target,
        lease: {
          ownerCatId: (body.catId ?? 'codex') as CatId,
          state: 'active',
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt: now + ttlMs,
        },
        updatedAt: now,
      };
      items = items.map((item) => (item.id === id ? updated : item));
      return mockResponse(200, { item: cloneItem(updated) });
    }

    const leaseHeartbeatMatch = path.match(/^\/api\/backlog\/items\/([^/]+)\/lease\/heartbeat$/);
    if (leaseHeartbeatMatch && init?.method === 'POST') {
      const id = decodeURIComponent(leaseHeartbeatMatch[1] ?? '');
      const body = JSON.parse(String(init.body)) as LeaseBody;
      const target = items.find((item) => item.id === id);
      if (!target) return mockResponse(404, { error: 'not found' });
      if (!target.lease) return mockResponse(409, { error: 'no active lease' });
      const ttlMs = body.ttlMs ?? 60_000;
      const now = Date.now();
      const updated: MutableBacklogItem = {
        ...target,
        lease: {
          ...target.lease,
          state: 'active',
          heartbeatAt: now,
          expiresAt: now + ttlMs,
        },
        updatedAt: now,
      };
      items = items.map((item) => (item.id === id ? updated : item));
      return mockResponse(200, { item: cloneItem(updated) });
    }

    const leaseReleaseMatch = path.match(/^\/api\/backlog\/items\/([^/]+)\/lease\/release$/);
    if (leaseReleaseMatch && init?.method === 'POST') {
      const id = decodeURIComponent(leaseReleaseMatch[1] ?? '');
      const body = JSON.parse(String(init.body || '{}')) as LeaseBody;
      const target = items.find((item) => item.id === id);
      if (!target) return mockResponse(404, { error: 'not found' });
      if (!target.lease) return mockResponse(409, { error: 'no active lease' });
      const now = Date.now();
      const updated: MutableBacklogItem = {
        ...target,
        lease: {
          ...target.lease,
          state: 'released',
          releasedAt: now,
          releasedBy: 'u_test',
          ownerCatId: (body.catId ?? target.lease.ownerCatId) as CatId,
        },
        updatedAt: now,
      };
      items = items.map((item) => (item.id === id ? updated : item));
      return mockResponse(200, { item: cloneItem(updated) });
    }

    const leaseReclaimMatch = path.match(/^\/api\/backlog\/items\/([^/]+)\/lease\/reclaim$/);
    if (leaseReclaimMatch && init?.method === 'POST') {
      const id = decodeURIComponent(leaseReclaimMatch[1] ?? '');
      const target = items.find((item) => item.id === id);
      if (!target) return mockResponse(404, { error: 'not found' });
      if (!target.lease) return mockResponse(409, { error: 'no lease to reclaim' });
      const now = Date.now();
      const updated: MutableBacklogItem = {
        ...target,
        lease: {
          ...target.lease,
          state: 'reclaimed',
          reclaimedAt: now,
          reclaimedBy: 'u_test',
        },
        updatedAt: now,
      };
      items = items.map((item) => (item.id === id ? updated : item));
      return mockResponse(200, { item: cloneItem(updated) });
    }

    const url = new URL(path, 'http://localhost');
    if (url.pathname === '/api/backlog/feature-doc-detail') {
      const featureId = url.searchParams.get('featureId') ?? 'F000';
      return mockResponse(200, {
        featureId: featureId.toUpperCase(),
        status: 'in-progress',
        owner: '布偶猫',
        phases: [
          {
            id: 'A',
            name: '基础架构',
            acs: [
              { id: 'AC-A1', text: 'Remote sync', done: true },
              { id: 'AC-A2', text: 'YAML parsing', done: true },
            ],
          },
          {
            id: 'B',
            name: '线程关联',
            acs: [
              { id: 'AC-B1', text: 'Fuzzy matching', done: true },
              { id: 'AC-B2', text: 'Progress dashboard', done: false },
            ],
          },
        ],
        risks: [{ risk: 'Format inconsistency', mitigation: 'Standard template' }],
        dependencies: {},
      });
    }

    return mockResponse(500, { error: `unexpected path: ${path}` });
  };

  return {
    setItems,
    getItems,
    setThreads,
    setSelfClaimScope,
    handleRequest,
  };
}
