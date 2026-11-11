import { evolutionExplorationReviewV1Schema } from '@cat-cafe/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { assetReviewFixture } from '@/components/capability-evolution/__tests__/evolution-asset-fixtures';
import { PROGRAM_ID, programFixture } from '@/components/capability-evolution/__tests__/evolution-fixtures';
import { useEvolutionReading } from '@/components/capability-evolution/evolution-reading-state';
import { useExplorationRequests } from '@/components/capability-evolution/exploration/exploration-requests';
import { apiFetch } from '@/utils/api-client';
import {
  explorationFixture,
  objectRef,
  source,
} from '../../../../api/test/capability-evolution-exploration.helper.mjs';
import { useEvolutionBindings } from '../useEvolutionBindings';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const program = () => ({
  ...programFixture('observing'),
  program: { ...programFixture('observing').program, objectRef },
  origin: { threadId: 'origin-thread', title: 'Owner program', createdByCatId: 'codex' },
});
const exploration = () => {
  const raw = explorationFixture({ withDetail: true });
  const node = {
    ...raw.nodes[0],
    title: 'Owner v2',
    nodeRef: { ...raw.nodes[0].nodeRef, version: 'v2' },
    versionRef: { ...raw.nodes[0].versionRef, version: 'v2' },
  };
  const experiment = {
    ...raw.experiments[0],
    experimentRef: source('run', 'v2'),
    nodeRef: node.nodeRef,
    title: 'Owner run v2',
  };
  const original = raw.details[0].records[0];
  const record = {
    ...original,
    experimentRef: experiment.experimentRef,
    nodeRef: node.nodeRef,
    recordRef: source('record', 'v2'),
    output: [{ label: 'HTTP', value: '200' }],
    values: { status: 200 },
  };
  const parsed = evolutionExplorationReviewV1Schema.parse({
    ...raw,
    nodes: [...raw.nodes, node],
    experiments: [...raw.experiments, experiment],
    details: [
      ...raw.details,
      { status: 'resolved', experimentRef: experiment.experimentRef, nodeRef: node.nodeRef, records: [record] },
    ],
  });
  if (parsed.status !== 'resolved') throw new Error('Expected resolved fixture');
  return parsed;
};

beforeEach(() => {
  localStorage.clear();
  useEvolutionReading.setState({ programs: {}, workspaceProgramIds: {}, workspacePages: {} });
  useExplorationRequests.setState({ records: {}, pending: {}, errors: {} });
  vi.mocked(apiFetch).mockReset();
});
afterEach(cleanup);

function mount(read = exploration()) {
  const owner = program(),
    writes: { path: string; body: Record<string, unknown> }[] = [];
  let loseReply = false;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    const p = String(path);
    if (init?.method === 'POST') {
      writes.push({ path: p, body: JSON.parse(String(init.body)) });
      if (loseReply) throw new TypeError('lost admission response');
      return response({ status: 'queued', userMessageId: 'owner-message' });
    }
    if (p === '/api/capability-evolution/programs') return response({ programs: [owner] });
    if (p.includes('/asset-review')) {
      const asset = assetReviewFixture('v2');
      return response({ ...asset, objectRef });
    }
    if (p.includes('/exploration?')) {
      const params = new URL(p, 'https://api.test').searchParams;
      const selected = [params.get('selectedExperimentRef'), params.get('comparisonExperimentRef')].filter(Boolean);
      return response({
        ...read,
        details: read.details.filter((detail) => selected.includes(JSON.stringify(detail.experimentRef))),
      });
    }
    if (p === '/api/cats') return response({ cats: [{ id: 'codex' }] });
    return response(owner);
  });
  const ui = { evoId: PROGRAM_ID, evoReading: {} };
  const { result } = renderHook(
    () => useEvolutionBindings(ui, true),
    (binding) => binding.ownerView,
  );
  return {
    result,
    ui,
    writes,
    loseReply: (value: boolean) => {
      loseReply = value;
    },
  };
}

it('reads exact exploration nodes, cases and comparable owner results without adopting a version', async () => {
  const source = exploration(),
    { result, writes, ui } = mount(source);
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui).evolutionExploration?.cases).toHaveLength(1),
  );
  expect(projectOwner('evolution', result.current, ui).evolutionExploration?.cases[0].fields).toContainEqual({
    field: 'metric',
    label: 'HTTP 状态',
    value: 200,
    measured: true,
    unit: 'code',
  });
  const sourceNode = source.nodes[0];
  await act(() => result.current.action('evoSelect', { field: 'evo-node', v: JSON.stringify(sourceNode.nodeRef) }));
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui).evolutionExploration?.cases[0].fields).toContainEqual({
      field: 'metric',
      label: 'HTTP 状态',
      value: 401,
      measured: true,
      unit: 'code',
    }),
  );
  await act(() =>
    result.current.action('evoSelect', {
      field: 'evo-compare',
      v: JSON.stringify(source.experiments[1].experimentRef),
    }),
  );
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui).evolutionExploration?.compare.hasError).toBe(false),
  );
  expect(
    projectOwner('evolution', result.current, ui).evolutionExploration?.compare.metrics[0].fields[0],
  ).toMatchObject({ left: 200, right: 401, unit: 'code', leftMeasured: true, rightMeasured: true });
  expect(writes).toEqual([]);
});

it('preserves a draft target while reading another node and reuses admission after a lost response', async () => {
  const source = exploration(),
    { result, writes, loseReply, ui } = mount(source);
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui).evolutionExploration?.request.canRequest).toBe(true),
  );
  const original = projectOwner('evolution', result.current, ui).evolutionExploration!.node;
  await act(() => result.current.action('evoDraft', { v: '核对同一输入 @opus' }));
  await act(() =>
    result.current.action('evoSelect', { field: 'evo-node', v: JSON.stringify(source.nodes[0].nodeRef) }),
  );
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui).evolutionExploration?.request.target).toBe('Owner v2'),
  );
  loseReply(true);
  await act(async () => {
    await expect(
      result.current.action('evoRequest', { programId: PROGRAM_ID, v: '核对同一输入 @opus' }),
    ).rejects.toThrow('请求尚未确认');
  });
  expect(projectOwner('evolution', result.current, ui).evolutionExploration?.request.draft).toBe('核对同一输入 @opus');
  loseReply(false);
  await act(() => result.current.action('evoRequest', { programId: PROGRAM_ID, v: '核对同一输入 @opus' }));
  expect(writes.map((w) => w.body.idempotencyKey)).toEqual([
    writes[0].body.idempotencyKey,
    writes[0].body.idempotencyKey,
  ]);
  expect(String(writes[1].body.content)).toContain(JSON.parse(original).version);
  expect(
    String(writes[1].body.content)
      .split('\n')
      .filter((line) => line.startsWith('@')),
  ).toEqual(['@codex']);
  expect(writes.every((w) => w.path === '/api/messages')).toBe(true);
  expect(projectOwner('evolution', result.current, ui).evolutionExploration?.request.draft).toBe('');
});

it('does not compare incomplete or differently conditioned records', async () => {
  const source = exploration();
  source.experiments[1].conditions.window.sourceRef.version = 'other-window';
  const other = source.details[1];
  if (other.status !== 'resolved') throw new Error('Expected resolved fixture');
  other.records[0].windowRef.version = 'other-window';
  const { result, ui } = mount(source);
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui).evolutionExploration?.cases).toHaveLength(1),
  );
  await act(() =>
    result.current.action('evoSelect', {
      field: 'evo-compare',
      v: JSON.stringify(source.experiments[0].experimentRef),
    }),
  );
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui).evolutionExploration?.compare.errors).toContain(
      'conditionsDiffer',
    ),
  );
  expect(projectOwner('evolution', result.current, ui).evolutionExploration?.compare.hasError).toBe(true);
});

it('submits a new goal to the captured thread with the same dialog operation identity', async () => {
  const { result, writes } = mount();
  await act(() =>
    result.current.action('evolutionNew', {
      threadId: 'captured-thread',
      operationId: 'same-goal-attempt',
      v: '改进检索',
    }),
  );
  expect(writes).toEqual([
    {
      path: '/api/messages',
      body: {
        threadId: 'captured-thread',
        idempotencyKey: 'same-goal-attempt',
        messageDisposition: 'continue_current',
        content: '我们来进化 改进检索',
      },
    },
  ]);
});

it('accepts the existing paired-subset reading action and shows only common inputs on both sides', async () => {
  const read = exploration(),
    first = read.details[0];
  if (first.status !== 'resolved') throw new Error('Expected resolved fixture');
  first.records.push({
    ...first.records[0],
    caseId: 'only-left',
    label: 'Unmatched source',
    recordRef: source('left-only'),
    inputRef: source('left-only-input'),
  });
  read.experiments[0].recordCount = 2;
  const { result, writes, ui } = mount(read);
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui).evolutionExploration?.cases).toHaveLength(1),
  );
  await act(() =>
    result.current.action('evoSelect', { field: 'evo-compare', v: JSON.stringify(read.experiments[0].experimentRef) }),
  );
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui).evolutionExploration?.compare.subset).not.toBeNull(),
  );
  const subset = projectOwner('evolution', result.current, ui).evolutionExploration!.compare.subset!;
  expect(projectOwner('evolution', result.current, ui).evolutionExploration?.compare.hasError).toBe(true);
  await act(() => result.current.action('evoSubset', { k: subset.k }));
  await waitFor(() =>
    expect(projectOwner('evolution', result.current, ui).evolutionExploration?.compare.hasError).toBe(false),
  );
  expect(projectOwner('evolution', result.current, ui).evolutionExploration?.compare.left.cases).toHaveLength(1);
  expect(projectOwner('evolution', result.current, ui).evolutionExploration?.compare.right.cases).toHaveLength(1);
  expect(projectOwner('evolution', result.current, ui).evolutionExploration?.compare.subset).toBeNull();
  expect(JSON.stringify(projectOwner('evolution', result.current, ui).evolutionExploration?.compare)).not.toContain(
    'Unmatched source',
  );
  expect(writes).toEqual([]);
  await act(() => result.current.action('evoSelect', { field: 'evo-compare', v: '' }));
  await act(async () => {
    await expect(result.current.action('evoSubset', { k: subset.k })).rejects.toThrow('比较对象已变化');
  });
});
