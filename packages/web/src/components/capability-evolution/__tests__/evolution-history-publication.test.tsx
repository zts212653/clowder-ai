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
    resolve(process.cwd(), '../shared/src/__tests__/fixtures/f314-history-publication-contract.json'),
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

function v3Archive() {
  const cases = archive.cases
    .slice(0, 2)
    .map((entry: Record<string, unknown>, index: number) => ({ ...structuredClone(entry), caseId: `v3-${index}` }));
  return {
    ...structuredClone(archive),
    schemaVersion: 3,
    cases,
    story: {
      updated: '2026-10-19',
      overviewMarkdown: '### 这条历史怎么读\n\n- 作者写完整正文\n- 页面只负责排版',
      sources: [
        {
          id: 'owner-source',
          label: '作者核对原件',
          path: 'docs/VISION.md',
        },
      ],
      steps: [
        {
          stepId: 'first-step',
          date: '2026-09-19',
          title: '正文属于作者',
          parentEdges: [],
          sourceIds: ['owner-source'],
          bodyMarkdown:
            '### 我们看见了什么\n\nSENTINEL_STEP_BODY。\n\n### 我们改了什么\n\n- 保留列表\n- [打开安全链接](https://example.com/history)\n\n### 仍待确认\n\n只陈述真实边界。',
        },
      ],
      cases: [
        {
          caseId: 'v3-0',
          stepId: 'first-step',
          title: '第一道错题',
          sourceIds: ['owner-source'],
          bodyMarkdown:
            '### 踩了什么坑\n\nSENTINEL_CASE_BODY。\n\n### 当时怎么应对\n\n1. 保留顺序\n2. 保留来源\n\n### 后来怎样\n\n[回到依据](https://example.com/case)',
        },
        {
          caseId: 'v3-1',
          stepId: 'first-step',
          title: '第二道错题',
          sourceIds: ['owner-source'],
          bodyMarkdown: '### 踩了什么坑\n\n另一条正文。\n\n### 当时怎么应对\n\n保留。\n\n### 后来怎样\n\n待观察。',
        },
      ],
    },
  };
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

it('renders v3 author Markdown once and keeps the historical map to date plus title', async () => {
  const authored = v3Archive();
  owner = new HarnessHistoryPublicationOwner({
    store: new MemoryHarnessHistoryPublicationStore(),
    source: {
      baseline: async () => a,
      read: async () => authored,
      acquire: async () => authored,
    },
  });
  await show();

  const history = host.querySelector<HTMLElement>('[aria-label="错题谱系"]');
  expect(history).not.toBeNull();
  expect(history?.querySelector('.exploration-history-overview h3')?.textContent).toBe('这条历史怎么读');
  expect(history?.querySelector('.exploration-history-step .markdown-content')?.textContent).toContain(
    'SENTINEL_STEP_BODY',
  );
  expect(history?.querySelector('.exploration-history-step .markdown-content ul')).not.toBeNull();
  expect(history?.querySelector<HTMLAnchorElement>('a[href="https://example.com/history"]')).not.toBeNull();
  expect(history?.textContent).not.toContain('这一步改了什么');

  const mapNode = history?.querySelector('.exploration-node');
  expect(mapNode?.textContent).toContain('2026-09-19');
  expect(mapNode?.textContent).toContain('正文属于作者');
  expect(mapNode?.textContent).not.toContain('SENTINEL_STEP_BODY');

  const toggle = [...(history?.querySelectorAll<HTMLButtonElement>('.exploration-history-case-toggle') ?? [])].find(
    (entry) => entry.textContent?.includes('第一道错题'),
  );
  if (!toggle) throw new Error('first authored case toggle missing');
  if (toggle.getAttribute('aria-expanded') !== 'true') await act(async () => toggle.click());
  await vi.waitFor(() =>
    expect(toggle?.closest('article')?.querySelector('.exploration-history-case-body')?.textContent).toContain(
      'SENTINEL_CASE_BODY',
    ),
  );
  const caseBody = toggle?.closest('article')?.querySelector('.exploration-history-case-body');
  expect(caseBody?.textContent).toContain('SENTINEL_CASE_BODY');
  expect(caseBody?.querySelector('ol')).not.toBeNull();
  expect(caseBody?.querySelector<HTMLAnchorElement>('a[href="https://example.com/case"]')).not.toBeNull();
  expect(caseBody?.textContent).not.toContain('后来怎样了');
});

it('keeps the legacy overview as literal reader copy instead of reinterpreting it as Markdown', async () => {
  const original = archive.story.overview;
  archive.story.overview = '### SENTINEL_LEGACY_OVERVIEW *原样保留*';
  try {
    await show();
    const overview = host.querySelector<HTMLElement>('.exploration-history-overview');
    expect(overview?.textContent).toBe(archive.story.overview);
    expect(overview?.querySelector('h3')).toBeNull();
    expect(overview?.querySelector('em')).toBeNull();
  } finally {
    if (original === undefined) delete archive.story.overview;
    else archive.story.overview = original;
  }
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

it.each([
  'added',
  'changed',
  'removed',
])('requires explicit adoption when the visible overview is %s', async (change) => {
  const originalOverview = archive.story.overview;
  const previousOverview = '原来正在阅读的总述';
  const nextOverview = '新发布、但尚未确认切换的总述';
  try {
    if (change === 'added') {
      delete archive.story.overview;
      next.story.overview = nextOverview;
    } else {
      archive.story.overview = previousOverview;
      if (change === 'changed') next.story.overview = nextOverview;
      else delete next.story.overview;
    }
    await show();
    const selected = useEvolutionReading.getState().programs[value.program.programId]?.exploration?.selectedSourceRef;
    await publish();
    expect(useEvolutionReading.getState().programs[value.program.programId]?.exploration?.selectedSourceRef).toEqual(
      selected,
    );
    expect(host.textContent).toContain('查看新版');
    if (change === 'added') expect(host.textContent).not.toContain(nextOverview);
    else expect(host.textContent).toContain(previousOverview);

    await act(async () => button('查看新版').click());
    if (change === 'removed') {
      expect(host.textContent).not.toContain(previousOverview);
      expect(host.textContent).toContain('一路走来踩过的坑、当时怎么改、后来怎样了。');
    } else expect(host.textContent).toContain(nextOverview);
  } finally {
    if (originalOverview === undefined) delete archive.story.overview;
    else archive.story.overview = originalOverview;
  }
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
  expect(archiveSummary.textContent).toContain('12 步 · 27 道错题');
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
    next.story.cases.find((entry: { caseId: string }) => entry.caseId === 'contract-addition-source').nodeId =
      'contract-step-02';
  else if (change === 'removed') {
    next.story.cases = next.story.cases.filter(
      (entry: { caseId: string }) => entry.caseId !== 'contract-selected-case',
    );
    next.cases = next.cases.filter((entry: { caseId: string }) => entry.caseId !== 'contract-selected-case');
  } else if (change === 'renamed')
    next.story.cases.find((entry: { caseId: string }) => entry.caseId === 'contract-selected-case').title =
      '另一道错题的新标题';
  else {
    const entry = next.cases.find((entry: { caseId: string }) => entry.caseId === 'contract-selected-case');
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

it('routes source relationships around unrelated historical step nodes', async () => {
  await show();
  const nodes = [...host.querySelectorAll<HTMLElement>('.exploration-node-wrap')].map((entry) => ({
    key: entry.dataset.key ?? '',
    title: entry.querySelector('.exploration-node-title')?.textContent,
    centerX: Number.parseFloat(entry.style.left),
    centerY: Number.parseFloat(entry.style.top),
  }));
  expect(nodes).toHaveLength(12);
  const collisions = [...host.querySelectorAll<SVGPathElement>('.exploration-edges path')].flatMap((path) => {
    const parent = nodes.find((node) => node.key === path.dataset.parentKey);
    const child = nodes.find((node) => node.key === path.dataset.childKey);
    if (!parent || !child) throw new Error('every visible edge must identify both endpoint nodes');
    const intervening = nodes.filter(
      (node) =>
        node.key !== parent.key &&
        node.key !== child.key &&
        node.centerX > Math.min(parent.centerX, child.centerX) &&
        node.centerX < Math.max(parent.centerX, child.centerX),
    );
    if (intervening.length > 0) expect(path.dataset.edgeRoute).toBe('history-clear');
    if (path.dataset.edgeRoute !== 'history-clear') return [];
    const raw = path.getAttribute('d') ?? '';
    const values = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    const points = Array.from({ length: values.length / 2 }, (_, index) => ({
      x: values[index * 2],
      y: values[index * 2 + 1],
    }));
    return points.slice(1).flatMap((point, index) => {
      const start = points[index];
      return nodes
        .filter((node) => node.key !== parent.key && node.key !== child.key)
        .filter((node) =>
          segmentCrossesBox(start, point, {
            left: node.centerX - 88,
            right: node.centerX + 88,
            top: node.centerY - 56,
            bottom: node.centerY + 56,
          }),
        )
        .map((node) => ({ crosses: node.title, path: raw }));
    });
  });
  expect(collisions, 'a source line through an unrelated dot visually invents ancestry').toEqual([]);
});

function segmentCrossesBox(
  start: { x: number; y: number },
  end: { x: number; y: number },
  box: { left: number; right: number; top: number; bottom: number },
) {
  return Array.from({ length: 81 }, (_, index) => index / 80).some((ratio) => {
    const x = start.x + (end.x - start.x) * ratio;
    const y = start.y + (end.y - start.y) * ratio;
    return x > box.left && x < box.right && y > box.top && y < box.bottom;
  });
}
