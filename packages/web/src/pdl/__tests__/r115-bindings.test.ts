import { afterEach, expect, it, vi } from 'vitest';
import { assetReviewFixture } from '@/components/capability-evolution/__tests__/evolution-asset-fixtures';
import { assetRef, PROGRAM_ID, programFixture } from '@/components/capability-evolution/__tests__/evolution-fixtures';
import type { EvolutionProgramProjection } from '@/components/capability-evolution/evolution-program-projection';
import { useEvolutionProgressRequests } from '@/components/capability-evolution/journey/evolution-progress-request';
import { apiFetch } from '@/utils/api-client';
import { useEvolutionBindings } from '../useEvolutionBindings';
import { useOpsBindings } from '../useOpsBindings';
import { fixtureData } from './chat-fixture';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const opsUi = () => ({
  opsView: 'rt',
  obsV: 'overview',
  lbRange: 'all',
  toolCat: '',
  toolType: '',
  toolRange: 7,
  rpReview: false,
  rpArch: false,
  rtView: null as string | null,
  rtTab: 'chat' as 'chat' | 'handoff' | 'raw',
  rtPage: 1,
  govPath: null as string | null,
  gov: {} as Record<string, boolean | string>,
  rescueSel: {} as Record<string, boolean>,
});
afterEach(cleanup);

it('reads exact asset history and receipts without adopting the selected version or borrowing another owner', async () => {
  const owner = programFixture();
  owner.program.currentAssetVersionRefs = [assetRef('v2')];
  const paths: string[] = [];
  let mismatch = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const p = String(path);
    paths.push(p);
    expect(init?.method ?? 'GET').toBe('GET');
    if (p === '/api/capability-evolution/programs') return response({ programs: [owner] });
    if (p.includes('/asset-review')) {
      const selected = new URL(p, 'https://api.test').searchParams.get('selectedVersionRef');
      const version = selected ? JSON.parse(selected).version : 'v2';
      const review = assetReviewFixture(version);
      if (mismatch) review.objectRef = { ...review.objectRef, ownerStateRef: 'different-object' };
      return response(review);
    }
    return response(owner);
  });
  const ui = { evoId: null as string | null, evoReading: {} };
  const { result } = renderHook(() => useEvolutionBindings(ui, true));
  await act(() => result.current.action('evolutionOpen', { id: PROGRAM_ID }));
  await waitFor(() =>
    expect(
      projectOwner('evolution', result.current, ui, undefined, undefined).evolutionAssets.selected?.uses[0].use,
    ).toBe('applied'),
  );
  expect(
    projectOwner('evolution', result.current, ui, undefined, undefined).evolutionAssets.versions.find(
      (v: { adopted: boolean }) => v.adopted,
    )?.ref.version,
  ).toBe('v2');
  await act(() =>
    result.current.action('evolutionOpen', { id: PROGRAM_ID, versionRef: JSON.stringify(assetRef('v1')) }),
  );
  await waitFor(() =>
    expect(
      projectOwner('evolution', result.current, ui, undefined, undefined).evolutionAssets.selected?.versionRef.version,
    ).toBe('v1'),
  );
  expect(projectOwner('evolution', result.current, ui, undefined, undefined).evolutionAssets.selected?.uses).toEqual(
    [],
  );
  expect(projectOwner('evolution', result.current, ui, undefined, undefined).evolutionAssets.diff?.summary).toBe(
    'v1 的人话变化说明',
  );
  expect(
    projectOwner('evolution', result.current, ui, undefined, undefined).evolutionAssets.versions.find(
      (v: { adopted: boolean }) => v.adopted,
    )?.ref.version,
  ).toBe('v2');
  expect(paths.some((p) => p.includes('selectedVersionRef='))).toBe(true);
  mismatch = true;
  await act(() => result.current.action('refresh', { k: 'evolution' }));
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui, undefined, undefined).cafeWsEvo.load).toBe('error'),
  );
  expect(projectOwner('evolution', result.current, ui, undefined, undefined).evolutionAssets.catalog).toBeUndefined();
  expect(projectOwner('evolution', result.current, ui, undefined, undefined).evolutionAssets.selected).toBeUndefined();
});

it('reads the opened session independently of filtering, uses owner cursors and resets them per view', async () => {
  const requests: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const p = String(path);
    requests.push(p);
    if (p.startsWith('/api/external-runtime-sessions?')) return response({ sessions: [] });
    if (p.startsWith('/api/external-runtime-sessions/'))
      return response({
        sessionId: 'session-owner',
        runtimeSessionId: 'runtime-owner',
        catId: 'codex',
        model: 'owner-model',
        threadId: 'owner-thread',
        binding: { mode: 'thread', threadId: 'owner-thread' },
      });
    const url = new URL(p, 'https://api.test');
    if (url.searchParams.get('view') === 'chat')
      return response({
        total: 3,
        messages: [
          {
            eventNo: Number(url.searchParams.get('cursor')),
            role: 'assistant',
            content: 'owner page ' + url.searchParams.get('cursor'),
            timestamp: 1,
          },
        ],
        ...(url.searchParams.get('cursor') === '0' ? { nextCursor: { eventNo: 47 } } : {}),
      });
    if (url.searchParams.get('view') === 'handoff')
      return response({
        total: 1,
        invocations: [
          {
            invocationId: 'owner-invocation',
            eventCount: 9,
            errors: 1,
            durationMs: 1234,
            toolCalls: ['owner-tool'],
            keyMessages: ['owner handoff'],
          },
        ],
      });
    return response({ total: 1, events: [{ eventNo: 99, event: { type: 'owner-raw' } }] });
  });
  const ui = opsUi();
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui, true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.load).toBe(''),
  );
  ui.rtView = 'session-owner';
  await act(() => result.current.action('opsBrowse', {}));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps).toMatchObject({
      rt: { d: { id: 'runtime-owner', first: true, last: false, rows: [{ text: 'owner page 0' }] } },
    }),
  );
  ui.rtPage = 2;
  await act(() => result.current.action('opsBrowse', {}));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps).toMatchObject({
      rt: { d: { last: true, rows: [{ text: 'owner page 47' }] } },
    }),
  );
  ui.rtTab = 'handoff';
  ui.rtPage = 1;
  await act(() => result.current.action('opsBrowse', {}));
  await waitFor(() =>
    expect(JSON.stringify(projectOwner('ops', result.current, ui, fixtureData(), undefined))).toContain(
      'owner handoff',
    ),
  );
  ui.rtTab = 'raw';
  await act(() => result.current.action('opsBrowse', {}));
  await waitFor(() =>
    expect(JSON.stringify(projectOwner('ops', result.current, ui, fixtureData(), undefined))).toContain('owner-raw'),
  );
  expect(requests).toContain('/api/sessions/session-owner/events?view=handoff&cursor=0&limit=30');
  expect(requests).not.toContain(expect.stringContaining('cursor=undefined'));
  expect(JSON.stringify(projectOwner('ops', result.current, ui, fixtureData(), undefined))).not.toContain('rt_9a01');
});

it('projects the owner oversized chat and handoff references without requiring omitted message bodies or arrays', async () => {
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const p = String(path);
    if (p.startsWith('/api/external-runtime-sessions/'))
      return response({
        sessionId: 'session-owner',
        catId: 'codex',
        binding: { mode: 'thread', threadId: 'pdl-test' },
      });
    const view = new URL(p, 'https://api.test').searchParams.get('view');
    const drillDown = { tool: 'read_session_events', args: { sessionId: 'session-owner', cursor: 8 } };
    return response(
      view === 'handoff'
        ? {
            total: 1,
            invocations: [{ invocationId: 'long-owner', eventCount: 30, startEventNo: 8, oversized: true, drillDown }],
          }
        : {
            total: 1,
            messages: [{ eventNo: 8, role: 'assistant', contentLength: 90000, oversized: true, drillDown }],
          },
    );
  });
  const ui = opsUi();
  ui.rtView = 'session-owner';
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui, true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.load).toBe(''),
  );
  expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps).toMatchObject({
    rt: { d: { rows: [{ id: '8', role: 'assistant', contentLength: 90000, oversized: true }] } },
  });
  ui.rtTab = 'handoff';
  await act(() => result.current.action('opsBrowse', {}));
  expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps).toMatchObject({
    rt: { d: { rows: [{ id: 'long-owner', eventCount: 30, oversized: true }] } },
  });
});

it('treats a generic 503 telemetry error as unavailable instead of a HealthData record', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ error: 'telemetry_disabled' }, 503));
  const ui = { ...opsUi(), opsView: 'obs' };
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui, true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.load).toBe('error'),
  );
  expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps).not.toHaveProperty('obs');
});

it('applies only the exact governance preview checksum and requires reconfirmation after a conflict', async () => {
  const writes: Record<string, unknown>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/governance/health')
      return response({
        projects: [
          {
            projectPath: '/owner-project',
            status: 'healthy',
            packVersion: 'owner-pack',
            lastSyncedAt: 1,
            findings: [],
          },
        ],
      });
    if (path === '/api/threads') return response({ threads: [] });
    const body = JSON.parse(String(init?.body));
    writes.push(body);
    const conflict = writes.length === 2;
    return response(
      {
        report: {
          projectPath: '/owner-project',
          dryRun: body.dryRun,
          selection: body.selection,
          previewChecksum: conflict ? 'owner-new-checksum' : 'owner-checksum',
          actions: [{ file: 'AGENTS.md', action: 'created', reason: 'Owner plan' }],
        },
      },
      conflict ? 409 : 200,
    );
  });
  const ui = opsUi();
  ui.opsView = 'gov';
  ui.govPath = '/owner-project';
  ui.gov = { guide: true, claude: true };
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui, true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.load).toBe(''),
  );
  await act(() => result.current.action('wsGovPrev', { v: 'add' }));
  await act(async () => {
    await expect(result.current.action('wsGovApply', {})).rejects.toThrow('重新确认');
  });
  expect(writes[1]).toMatchObject({
    projectPath: '/owner-project',
    dryRun: false,
    selection: { projectGuide: { thinEntrypoints: ['claude'] } },
    expectedPreviewChecksum: 'owner-checksum',
  });
  await act(() => result.current.action('wsGovApply', {}));
  expect(writes[2].expectedPreviewChecksum).toBe('owner-new-checksum');
  ui.gov.docs = true;
  await act(async () => {
    await expect(result.current.action('wsGovApply', {})).rejects.toThrow('重新预览');
  });
  expect(writes).toHaveLength(3);
});

it('keeps brake owner state after a failed save and rescues only scanned selected sessions', async () => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let rescued = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const p = String(path);
    if (init?.method) {
      writes.push({ path: p, body: JSON.parse(String(init.body)) });
      if (p === '/api/brake/settings') return response({ error: 'owner refused' }, 503);
      rescued = true;
      return response({
        status: 'partial',
        rescuedCount: 1,
        skippedCount: 0,
        results: [{ sessionId: 'selected-owner', status: 'repaired', removedTurns: 2, backupPath: 'owner-backup' }],
      });
    }
    if (p === '/api/brake/settings') return response({ enabled: false, mode: 'hardcore', thresholdMinutes: 90 });
    return response({
      sessions: rescued
        ? []
        : ['selected-owner', 'unselected-owner'].map((sessionId) => ({
            sessionId,
            transcriptPath: 'owner-path',
            removableThinkingTurns: 2,
            detectedBy: 'short_signature',
          })),
    });
  });
  const ui = opsUi();
  ui.opsView = 'brake';
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui, true));
  await waitFor(() =>
    expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps.load).toBe(''),
  );
  await act(async () => {
    await expect(
      result.current.action('opsBrakeSet', { k: 'enabled', v: true } as unknown as Record<string, string>),
    ).rejects.toThrow('owner refused');
  });
  expect(writes[0].body).toEqual({ enabled: true });
  expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps).toMatchObject({
    brake: {
      mode: 'hardcore',
      on: false,
    },
  });
  ui.opsView = 'rescue';
  await act(() => result.current.action('opsBrowse', {}));
  await waitFor(() =>
    expect(JSON.stringify(projectOwner('ops', result.current, ui, fixtureData(), undefined))).toContain(
      'selected-owner',
    ),
  );
  ui.rescueSel['unselected-owner'] = false;
  ui.rescueSel['unscanned-owner'] = true;
  await act(() => result.current.action('wsRescue', {}));
  expect(writes[1]).toEqual({ path: '/api/claude-rescue/rescue', body: { sessionIds: ['selected-owner'] } });
  expect(projectOwner('ops', result.current, ui, fixtureData(), undefined).cafeWsOps).toMatchObject({
    rescue: {
      found: false,
      last: {
        status: 'partial',
        rescuedCount: 1,
        skippedCount: 0,
        results: [{ sessionId: 'selected-owner', status: 'repaired', backupPath: 'owner-backup', removedTurns: 2 }],
      },
    },
  });
});

it('uses exact evolution reads and shared lifecycle writer, accepts CAS owner state and rejects stale commands', async () => {
  let owner: EvolutionProgramProjection = programFixture('constituting');
  const writes: Record<string, unknown>[] = [];
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith('/commands')) {
      const command = JSON.parse(String(init?.body));
      writes.push(command);
      owner = { ...owner, program: { ...owner.program, sequence: 2, lifecycle: 'paused' } };
      return response({ projection: owner }, 409);
    }
    if (path === '/api/capability-evolution/programs') return response({ programs: [owner] });
    return response(owner);
  });
  useEvolutionProgressRequests.setState({ records: {}, pending: {}, errors: {} });
  const ui = { evoId: null as string | null, evoReading: {} };
  const { result } = renderHook(() => useEvolutionBindings(ui, true));
  await act(() => result.current.action('evolutionOpen', { id: PROGRAM_ID }));
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui, undefined, undefined).evolutionOwner?.program.programId).toBe(
      PROGRAM_ID,
    ),
  );
  await act(async () => {
    await expect(
      result.current.action('evoLifecycle', { programId: PROGRAM_ID, expectedRevision: '1', op: 'pause' }),
    ).rejects.toThrow('最新状态');
  });
  expect(writes[0]).toMatchObject({
    expectedSequence: 1,
    action: { type: 'pause', reasonRef: { ownerFeatureId: 'F311' } },
  });
  expect(projectOwner('evolution', result.current, ui, undefined, undefined).evolutionOwner?.program.lifecycle).toBe(
    'paused',
  );
  await act(async () => {
    await expect(
      result.current.action('evoLifecycle', { programId: PROGRAM_ID, expectedRevision: '1', op: 'resume' }),
    ).rejects.toThrow('已更新');
  });
  expect(writes).toHaveLength(1);
});
