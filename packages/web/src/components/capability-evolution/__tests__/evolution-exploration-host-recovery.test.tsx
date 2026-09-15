import {
  type EvolutionResolvedExplorationReviewV1,
  evolutionExplorationReviewV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createEvolutionProgramSurface } from '@/components/workbench/real-surface-adapters';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { explorationFixture, source } from '../../../../../api/test/capability-evolution-exploration.helper.mjs';
import { CapabilityEvolutionProgramDetail } from '../CapabilityEvolutionProgramDetail';
import { EvolutionProgramSurface } from '../EvolutionProgramSurface';
import { DEFAULT_READING, useEvolutionReading } from '../evolution-reading-state';
import { DEFAULT_EXPLORATION } from '../exploration/exploration-reading';
import { progressRequestKey, useEvolutionProgressRequests } from '../journey/evolution-progress-request';
import { assetReviewFixture } from './evolution-asset-fixtures';
import { assetRef, PROGRAM_ID, programFixture } from './evolution-fixtures';
import { ownerExplorationFixture } from './evolution-owner-exploration-fixture';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
const surface = createEvolutionProgramSurface(PROGRAM_ID);
const projection = {
  ...programFixture('instrumenting'),
  origin: { threadId: 'thread-owner', title: '发起对话', createdByCatId: 'codex-sol' },
};
const publicRef = source('public-controller');
const runRef = source('public-run');
let host: HTMLDivElement;
let root: Root;
let releaseOwner: ((response: Response) => void) | undefined;
let ownerPending: boolean;
let explorationDown: boolean;
let comparisonEnabled: boolean;
let sourceFailure: 'unavailable' | 'invalid' | undefined;
let recordFailure: 'unavailable' | 'invalid' | undefined;
const compareRunRef = source('public-run-before');
const publication = (): EvolutionResolvedExplorationReviewV1 => {
  const review = ownerExplorationFixture();
  review.nodes.push({
    kind: 'public_archive',
    nodeRef: publicRef,
    title: '公开 v8',
    summary: '真实归档',
    sourceRef: source('publication'),
    changes: [],
    parentEdges: [],
  });
  const example = evolutionExplorationReviewV1Schema.parse(explorationFixture({ withDetail: true }));
  if (example.status !== 'resolved' || example.details[0]?.status !== 'resolved')
    throw new Error('invalid test record');
  review.experiments = [{ ...example.experiments[0]!, nodeRef: publicRef, experimentRef: runRef }];
  review.details = [
    {
      status: 'resolved',
      nodeRef: publicRef,
      experimentRef: runRef,
      records: [{ ...example.details[0].records[0]!, nodeRef: publicRef, experimentRef: runRef }],
    },
  ];
  if (comparisonEnabled) {
    const original = example.details[0].records[0]!;
    review.experiments.push({
      ...review.experiments[0]!,
      experimentRef: compareRunRef,
      recordCount: 2,
      conditions: {
        ...review.experiments[0]!.conditions,
        sampleSet: { ...review.experiments[0]!.conditions.sampleSet, sourceRef: source('earlier-samples') },
      },
    });
    review.details.push({
      status: 'resolved',
      nodeRef: publicRef,
      experimentRef: compareRunRef,
      records: [
        { ...original, nodeRef: publicRef, experimentRef: compareRunRef, recordRef: source('prior-record') },
        {
          ...original,
          nodeRef: publicRef,
          experimentRef: compareRunRef,
          caseId: 'other-input',
          recordRef: source('prior-other-record'),
          inputRef: source('other-input'),
        },
      ],
    });
  }
  return review;
};
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ownerPending = false;
  explorationDown = false;
  comparisonEnabled = false;
  sourceFailure = undefined;
  recordFailure = undefined;
  releaseOwner = undefined;
  localStorage.clear();
  useEvolutionReading.setState({ programs: { [PROGRAM_ID]: { ...DEFAULT_READING, journeyMoment: 2 } } });
  useEvolutionProgressRequests.setState({ records: {}, pending: {}, errors: {} });
  useF307ExperienceWorkbenchStore.setState({
    layout: createInitialWorkbenchState([surface]),
    hydrated: true,
    mainAreaAttentionSurfaceId: surface.id,
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  api.fetch.mockReset().mockImplementation(async (path: string) => {
    if (path.includes('/asset-review'))
      return ownerPending
        ? new Promise<Response>((resolve) => {
            releaseOwner = resolve;
          })
        : Response.json(
            assetReviewFixture(
              JSON.parse(new URL(path, 'http://cafe.invalid').searchParams.get('selectedVersionRef') ?? 'null')
                ?.version ?? 'v2',
            ),
          );
    if (path.includes('/exploration')) {
      if (explorationDown) return new Response('Offline', { status: 503 });
      const value = publication();
      if (sourceFailure)
        return Response.json(
          {
            schemaVersion: 1,
            status: sourceFailure,
            programRef: value.programRef,
            objectRef: value.objectRef,
            blockers: [{ code: 'target_drift', ownerRef: value.objectRef }],
          },
          { status: sourceFailure === 'invalid' ? 422 : 503 },
        );
      const params = new URL(path, 'http://cafe.invalid').searchParams;
      const requested = ['selectedExperimentRef', 'comparisonExperimentRef']
        .map((key) => params.get(key))
        .filter((value): value is string => value !== null)
        .map((value) => refIdentity(JSON.parse(value)));
      value.details = value.details.filter((detail) => requested.includes(refIdentity(detail.experimentRef)));
      if (recordFailure)
        value.details = value.details.map((detail) => ({
          status: recordFailure!,
          nodeRef: detail.nodeRef,
          experimentRef: detail.experimentRef,
          reason: recordFailure === 'invalid' ? '原始记录哈希未通过核验' : '原始记录当前无法读取',
        }));
      return Response.json(value);
    }
    return Response.json(projection);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
it.each([
  'main',
  'detail',
] as const)('retains an existing progress receipt while reading exploration in %s', async (mode) => {
  useEvolutionProgressRequests.setState({
    records: {
      [progressRequestKey(projection)]: {
        clientMessageId: '12345678-1234-4123-8123-123456789012',
        receipt: { status: 'queued', userMessageId: 'prior-progress' },
      },
    },
  });
  await act(async () =>
    root.render(
      mode === 'main' ? (
        <EvolutionProgramSurface programId={PROGRAM_ID} />
      ) : (
        <CapabilityEvolutionProgramDetail
          projection={projection}
          onClose={() => undefined}
          onOpenProgram={() => undefined}
        />
      ),
    ),
  );
  expect(host.querySelector('[data-testid="evolution-progress-receipt"]')).not.toBeNull();
  expect(host.textContent).toContain('推进请求已排队');
});
it('keeps owner decisions, content and actual-use reads reachable when exploration is unavailable', async () => {
  explorationDown = true;
  await act(async () => root.render(<EvolutionProgramSurface programId={PROGRAM_ID} />));
  expect(host.querySelector('[data-testid="evolution-change-panel"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="后续任务实际使用"]')).not.toBeNull();
  expect(host.textContent).toContain('v2 的人话变化说明');
});
it('owner recovery initializes its own read without replacing the selected public experiment and case', async () => {
  ownerPending = true;
  useEvolutionReading.getState().update(PROGRAM_ID, {
    exploration: {
      ...DEFAULT_EXPLORATION,
      selectedNodeRef: publicRef,
      selectedExperimentRef: runRef,
      selectedCaseId: 'anonymous',
      viewport: { x: 73, y: 18, zoom: 1.2, collapsed: [] },
    },
  });
  await act(async () => root.render(<EvolutionProgramSurface programId={PROGRAM_ID} />));
  expect(host.textContent).toContain('公开 v8');
  const before = useEvolutionReading.getState().programs[PROGRAM_ID]!.exploration;
  expect(releaseOwner).toBeDefined();
  await act(async () => releaseOwner!(Response.json(assetReviewFixture('v2'))));
  const after = useEvolutionReading.getState().programs[PROGRAM_ID]!.exploration;
  expect(after).toEqual(before);
  expect(refIdentity(after!.selectedNodeRef!)).toBe(refIdentity(publicRef));
});

it('inspecting a formal version preserves the user-confirmed comparison, case, viewport and persisted draft', async () => {
  comparisonEnabled = true;
  useEvolutionReading.getState().update(PROGRAM_ID, {
    selectedVersionRef: assetRef('v2'),
    exploration: {
      ...DEFAULT_EXPLORATION,
      selectedNodeRef: publicRef,
      selectedExperimentRef: runRef,
      comparisonExperimentRef: compareRunRef,
      selectedCaseId: 'anonymous',
      viewport: { x: 73, y: 18, zoom: 1.2, collapsed: [] },
      draft: { intent: 'explore', text: '保留这次共同样本的判断' },
    },
  });
  await act(async () => root.render(<EvolutionProgramSurface programId={PROGRAM_ID} />));
  const consent = [...host.querySelectorAll('button')].find((button) => button.textContent === '仅比较共同的 1 个场景');
  expect(consent).toBeDefined();
  await act(async () => consent!.click());
  const before = useEvolutionReading.getState().programs[PROGRAM_ID]!.exploration!;
  expect(before.comparisonScope).toBe('paired_subset');
  expect(before.comparisonScopeKey).toBeTruthy();
  const selector = host.querySelector<HTMLSelectElement>('select[aria-label="本项目正式版本"]')!;
  expect(selector).not.toBeNull();
  await act(async () => {
    selector.value = refIdentity(assetRef('v1'));
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(useEvolutionReading.getState().programs[PROGRAM_ID]!.selectedVersionRef).toEqual(assetRef('v1'));
  expect(useEvolutionReading.getState().programs[PROGRAM_ID]!.exploration).toEqual(before);
  expect(host.textContent).toContain('公开 v8');
  const persisted = JSON.parse(localStorage.getItem('f311-program-reading-v1')!);
  expect(persisted.state.programs[PROGRAM_ID].exploration).toEqual(before);
  await act(async () =>
    [...host.querySelectorAll('[role="tab"]')]
      .find((b) => b.textContent === '更改历史')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  const versions = host.querySelector('section[aria-label="阅读版本"]')!;
  const next = [...versions.querySelectorAll('button')].find((b) => b.textContent?.includes('v2'))!;
  await act(async () => next.click());
  const navigated = useEvolutionReading.getState().programs[PROGRAM_ID]!;
  expect(navigated.selectedVersionRef).toEqual(assetRef('v2'));
  expect(navigated.exploration).toEqual({
    viewport: before.viewport,
    comparisonScope: 'full',
    draft: before.draft,
    ...(before.lineageCollapsed === undefined ? {} : { lineageCollapsed: before.lineageCollapsed }),
  });
  expect(JSON.parse(localStorage.getItem('f311-program-reading-v1')!).state.programs[PROGRAM_ID].exploration).toEqual(
    navigated.exploration,
  );
});

it.each([
  'unavailable',
  'invalid',
] as const)('retains canonical owner blockers in the real %s exploration failure view', async (status) => {
  sourceFailure = status;
  await act(async () => root.render(<EvolutionProgramSurface programId={PROGRAM_ID} />));
  const sources = host.querySelector('[aria-label="探索来源待确认"]');
  expect(sources).not.toBeNull();
  expect(sources!.textContent).toContain('版本来源的目标已变化');
  expect(sources!.textContent).toContain('target_drift');
  expect(host.querySelector('[data-testid="evolution-change-panel"]')).not.toBeNull();
});

it('invalid detail removes its old result, keeps its coordinates, and waits for explicit revalidation', async () => {
  useEvolutionReading.getState().update(PROGRAM_ID, {
    exploration: {
      ...DEFAULT_EXPLORATION,
      selectedNodeRef: publicRef,
      selectedExperimentRef: runRef,
      selectedCaseId: 'anonymous',
    },
  });
  await act(async () => root.render(<EvolutionProgramSurface programId={PROGRAM_ID} />));
  expect(host.querySelector('[aria-label="所选案例结果"]')).not.toBeNull();
  recordFailure = 'invalid';
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(host.textContent).toContain('原始记录哈希未通过核验');
  expect(host.querySelector('[aria-label="所选案例结果"]')).toBeNull();
  expect(useEvolutionReading.getState().programs[PROGRAM_ID]!.exploration!.selectedCaseId).toBe('anonymous');
  const reads = () => api.fetch.mock.calls.filter(([path]) => path.includes('/exploration')).length;
  const before = reads();
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(reads()).toBe(before);
  recordFailure = undefined;
  await act(async () =>
    [...host.querySelectorAll('button')].find((entry) => entry.textContent === '核对后重读本轮记录')!.click(),
  );
  expect(reads()).toBe(before + 1);
  expect(host.querySelector('[aria-label="所选案例结果"]')).not.toBeNull();
});

it('the collapsed owner detail also surfaces invalid experiment records and an explicit recovery action', async () => {
  recordFailure = 'invalid';
  useEvolutionReading.getState().update(PROGRAM_ID, {
    exploration: { ...DEFAULT_EXPLORATION, selectedNodeRef: publicRef, selectedExperimentRef: runRef },
  });
  await act(async () =>
    root.render(
      <CapabilityEvolutionProgramDetail
        projection={projection}
        onClose={() => undefined}
        onOpenProgram={() => undefined}
      />,
    ),
  );
  const summary = host.querySelector('[aria-label="探索进化摘要"]')!;
  expect(summary).not.toBeNull();
  expect(summary.textContent).toContain('原始记录哈希未通过核验');
  expect([...summary.querySelectorAll('button')].some((entry) => entry.textContent === '核对后重读本轮记录')).toBe(
    true,
  );
});
