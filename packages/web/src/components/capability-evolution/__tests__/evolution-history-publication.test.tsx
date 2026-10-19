import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HarnessHistoryPublicationOwner } from '../../../../../api/src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-owner';
import { MemoryHarnessHistoryPublicationStore } from '../../../../../api/src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-store';
import { CapabilityEvolutionProgramDetail } from '../CapabilityEvolutionProgramDetail';
import { parseProgramProjection } from '../evolution-program-projection';
import { useEvolutionReading } from '../evolution-reading-state';
import { DEFAULT_EXPLORATION } from '../exploration/exploration-reading';
import { EvolutionMomentContext } from '../journey/EvolutionMomentContext';
import { programFixture } from './evolution-fixtures';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));
const archive = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../../docs/discussions/f314-incident-archive/lineage/lineage-index.json'),
    'utf8',
  ),
);
const value = programFixture('observing');
value.program.objectRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'capability:development-process-harness-effectiveness',
};
function parseFixtureProjection() {
  const projection = parseProgramProjection(value);
  if (!projection) throw new Error('history fixture must be a valid Program projection');
  return projection;
}
const projection = parseFixtureProjection();
const input = {
  programRef: { ownerFeatureId: 'F311', ownerStateRef: value.program.programId },
  objectRef: value.program.objectRef,
};
const a = 'a'.repeat(40),
  b = 'b'.repeat(40);
let owner: HarnessHistoryPublicationOwner;
let next: typeof archive;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  useEvolutionReading.setState({ programs: {} });
  next = structuredClone(archive);
  owner = new HarnessHistoryPublicationOwner({
    store: new MemoryHarnessHistoryPublicationStore(),
    source: {
      baseline: async () => a,
      read: async (revision) => (revision === b ? next : archive),
      acquire: async () => next,
    },
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  api.fetch.mockImplementation(async (path: string) => {
    if (!path.includes('/exploration')) return new Response('{}', { status: 404 });
    const url = new URL(path, 'https://cafe.invalid');
    const selection = Object.fromEntries([...url.searchParams].map(([key, entry]) => [key, JSON.parse(entry)]));
    const result = await owner.read({ ...input, ...selection });
    return Response.json(result, { status: result.status === 'resolved' ? 200 : 422 });
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
async function show() {
  await act(async () =>
    root.render(<EvolutionMomentContext projection={projection} moment={2} explorationMode="workspace" />),
  );
}
async function publish() {
  await owner.publish(
    input,
    { action: 'publish', expectedRevision: 0, sourceRevision: b, clientMessageId: 'publish-b', reason: '补上后续结果' },
    { actorRef: 'cat:codex-astra', originRef: 'thread:fixture:invocation:test' },
  );
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
}
const button = (text: string) => {
  const match = [...host.querySelectorAll('button')].find((entry) => entry.textContent?.includes(text));
  if (!match) throw new Error(`missing button containing: ${text}`);
  return match;
};

it('pins the source, preserves the current body until explicit replacement, and keeps the same reading DOM', async () => {
  await show();
  expect(
    useEvolutionReading.getState().programs[value.program.programId]?.exploration?.selectedSourceRef,
  ).toBeDefined();
  const article = host.querySelector('[data-history-step]');
  const original = article?.textContent;
  next.story.nodes[0].summary = '这一步刚补上的后来结果';
  await publish();
  expect(host.querySelector('[data-history-step] > header')?.textContent).toContain(archive.story.nodes[0].summary);
  expect(host.textContent).toContain('查看新版');
  await act(async () => button('查看新版').click());
  expect(host.querySelector('[data-history-step]')).toBe(article);
  expect(host.textContent).toContain('这一步刚补上的后来结果');
  expect(
    useEvolutionReading.getState().programs[value.program.programId]?.exploration?.selectedSourceRef?.version,
  ).toContain(b);
  expect(original).toBeTruthy();
});

it('automatically adopts unrelated updates while retaining collapsed cases', async () => {
  await show();
  const article = host.querySelector('[data-history-step]');
  const toggle = host.querySelector<HTMLButtonElement>('.exploration-history-case-toggle');
  if (!toggle) throw new Error('history case toggle missing');
  await act(async () => toggle.click());
  next.story.nodes.at(-1).summary = '其他步骤新增说明';
  await publish();
  expect(
    useEvolutionReading.getState().programs[value.program.programId]?.exploration?.selectedSourceRef?.version,
  ).toContain(b);
  expect(host.querySelector('[data-history-step]')).toBe(article);
  expect(host.querySelector('.exploration-history-case-toggle')?.getAttribute('aria-expanded')).toBe('false');
});

it.each(['period', 'updatedThrough'])('requires explicit adoption when visible %s metadata changes', async (field) => {
  await show();
  const selected = useEvolutionReading.getState().programs[value.program.programId]?.exploration?.selectedSourceRef;
  if (field === 'period') next.story.nodes[0].when = '9月2日 · 后续补记';
  else next.story.updated = archive.story.updated === '2026-10-18' ? '2026-10-19' : '2026-10-18';
  await publish();
  expect(useEvolutionReading.getState().programs[value.program.programId]?.exploration?.selectedSourceRef).toEqual(
    selected,
  );
  expect(host.textContent).toContain('查看新版');
  const updatedText = field === 'period' ? next.story.nodes[0].when : next.story.updated;
  expect(host.textContent).not.toContain(updatedText);
  await act(async () => button('查看新版').click());
  expect(host.textContent).toContain(updatedText);
});

it('recovers legacy saved references only through the owner-issued explicit action', async () => {
  useEvolutionReading.getState().update(value.program.programId, {
    exploration: {
      ...DEFAULT_EXPLORATION,
      selectedNodeRef: { ownerFeatureId: 'F314', ownerStateRef: 'harness-history:release:H01', version: 'old' },
    },
  });
  await show();
  expect(host.textContent).toContain('上次阅读位置属于较早的内容版本');
  expect(host.querySelector('[data-history-step]')).toBeNull();
  await act(async () => button('打开最新历史').click());
  expect(host.querySelector('[data-history-step] h3')?.textContent).toBe(archive.story.nodes[0].title);
  expect(
    useEvolutionReading.getState().programs[value.program.programId]?.exploration?.selectedSourceRef,
  ).toBeDefined();
});

it('puts the readable archive and explicit recovery before evaluation gaps in the v2 Program detail', async () => {
  localStorage.setItem('cat-cafe:shell-presentation', 'v2');
  const legacyNodeRef = {
    ownerFeatureId: 'F314',
    ownerStateRef: 'harness-history:release:H01',
    version: 'old',
  };
  useEvolutionReading.getState().update(value.program.programId, {
    journeyMoment: 2,
    exploration: { ...DEFAULT_EXPLORATION, selectedNodeRef: legacyNodeRef },
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

  const recovery = host.querySelector<HTMLElement>('[aria-label="最新历史可读"]');
  const evaluation = host.querySelector<HTMLElement>('[aria-label="项目效果评估状态"]');
  if (!recovery || !evaluation) throw new Error('history recovery and evaluation status must both render');
  expect(recovery.textContent).toContain('最新历史已经发布，可以直接阅读');
  expect(host.textContent).not.toContain('仍有来源待确认');
  expect(evaluation.textContent).toContain('项目效果评估仍待补证');
  expect(evaluation.textContent).toContain('不是查看已发布探索记录的前置条件');
  expect(recovery.compareDocumentPosition(evaluation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(useEvolutionReading.getState().programs[value.program.programId]?.exploration?.selectedNodeRef).toEqual(
    legacyNodeRef,
  );

  await act(async () => button('打开最新历史').click());
  const archiveSummary = host.querySelector<HTMLElement>('[aria-label="错题谱系"]');
  if (!archiveSummary) throw new Error('latest history summary missing after explicit recovery');
  expect(archiveSummary.textContent).toContain('11 步 · 26 道错题');
  expect(archiveSummary.compareDocumentPosition(evaluation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it.each([
  'added',
  'removed',
  'renamed',
  'window',
])('keeps the current step until explicit adoption when a case is %s', async (change) => {
  await show();
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="选择阅读步骤"]');
  expect(select).not.toBeNull();
  await act(async () => {
    if (!select) throw new Error('step selector missing');
    select.selectedIndex = 1;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const selected = useEvolutionReading.getState().programs[value.program.programId]?.exploration?.selectedSourceRef;
  const original = host.querySelector('.exploration-history-cases')?.textContent;
  expect(host.querySelectorAll('.exploration-history-case-toggle')).toHaveLength(2);
  if (change === 'added')
    next.story.cases.find((entry: { caseId: string }) => entry.caseId === 'C').nodeId = 'whole-result';
  else if (change === 'removed') {
    next.story.cases = next.story.cases.filter((entry: { caseId: string }) => entry.caseId !== 'K');
    next.cases = next.cases.filter((entry: { caseId: string }) => entry.caseId !== 'K');
  } else if (change === 'renamed')
    next.story.cases.find((entry: { caseId: string }) => entry.caseId === 'K').problem = '另一道错题的新标题';
  else {
    const entry = next.cases.find((entry: { caseId: string }) => entry.caseId === 'K');
    delete entry.occurredWindow;
    entry.occurredOn = '2026-09-03';
  }
  await publish();
  expect(useEvolutionReading.getState().programs[value.program.programId]?.exploration?.selectedSourceRef).toEqual(
    selected,
  );
  expect(host.querySelector('.exploration-history-cases')?.textContent).toEqual(original);
  expect(host.textContent).toContain('查看新版');
  await act(async () => button('查看新版').click());
  expect(host.querySelector('.exploration-history-cases')?.textContent).not.toEqual(original);
});

it.each([
  'transport',
  'source',
])('retains the old readable draft after a failed switch and a subsequent %s outage', async (failure) => {
  await show();
  const article = host.querySelector('[data-history-step]');
  const originalCase = host.querySelector('.exploration-history-case-body')?.textContent;
  expect(originalCase).toBeTruthy();
  next.story.nodes[0].summary = '新版结果';
  await publish();
  api.fetch.mockImplementation(async () =>
    failure === 'transport'
      ? new Response('unavailable', { status: 503 })
      : Response.json(
          {
            schemaVersion: 1,
            ...input,
            status: 'unavailable',
            blockers: [{ code: 'owner_historical_index_unavailable', ownerRef: input.objectRef }],
          },
          { status: 503 },
        ),
  );
  await act(async () => button('查看新版').click());
  expect(host.querySelector('[data-history-step]')).toBe(article);
  expect(host.textContent).toContain('新版暂时无法读取');
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(host.querySelector('[data-history-step]')).toBe(article);
  expect(host.textContent).toContain(archive.story.nodes[0].summary);
  expect(host.querySelector('.exploration-history-case-body')?.textContent).toContain(originalCase);
});
