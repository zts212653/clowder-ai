import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createEvolutionProgramSurface } from '@/components/workbench/real-surface-adapters';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { CapabilityEvolutionProgramDetail } from '../CapabilityEvolutionProgramDetail';
import { EvolutionProgramSurface } from '../EvolutionProgramSurface';
import { useEvolutionReading } from '../evolution-reading-state';
import { EvolutionMomentContext } from '../journey/EvolutionMomentContext';
import { assetReviewFixture } from './evolution-asset-fixtures';
import { assetRef, ownerRef, PROGRAM_ID, programFixture } from './evolution-fixtures';
import { ownerExplorationFixture } from './evolution-owner-exploration-fixture';
import { evolutionPreparationFixture } from './evolution-preparation-fixtures';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
const surface = createEvolutionProgramSurface(PROGRAM_ID);
const projection = programFixture('constituting');
const base = {
  schemaVersion: 1,
  programRef: { ownerFeatureId: 'F311', ownerStateRef: PROGRAM_ID },
  objectRef: projection.program.objectRef,
};
// Generic owner contract sentinel; actual Microduck data is exercised by the owner browser fixture.
const preparation = {
  ...base,
  status: 'resolved',
  sourceRef: ownerRef('preparation'),
  readAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-06T23:59:00.000Z',
  groups: [
    {
      groupRef: ownerRef('owner-named-group'),
      title: '来源自定的研究材料',
      items: [
        {
          materialRef: ownerRef('published'),
          title: '已有环境',
          summary: '公开记录已准备，尚未进行独立验证。',
          status: 'available',
          facts: [
            { label: '负责角色', value: '评估来源维护者' },
            { label: '还缺什么', value: '独立验证记录' },
          ],
          resources: [],
        },
        {
          materialRef: ownerRef('planned'),
          title: '后续任务计划',
          summary: '还未执行。',
          status: 'planned',
          resources: [],
        },
        {
          materialRef: ownerRef('candidate'),
          title: '公开选项 A',
          summary: '公开比较未达到阈值，因此不进入下一轮；这不是正式采用。',
          status: 'available',
          candidateVersionRef: assetRef('v3'),
          resources: [
            { label: '公开取舍原文', sourceRef: ownerRef('decision'), ownerHref: '/sources/public-decision' },
          ],
        },
      ],
    },
  ],
  blockers: [{ code: 'verification_missing', ownerRef: ownerRef('missing') }],
};

describe('owner-published preparation and candidates before constitution', () => {
  let host: HTMLDivElement;
  let root: Root;
  let readValue: unknown;
  let fail: boolean;
  let openProgram: (programId: string, view?: 'judgment' | 'history') => void;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useEvolutionReading.setState({ programs: {}, workspaceProgramIds: {} });
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: surface.id,
    });
    readValue = preparation;
    fail = false;
    openProgram = vi.fn();
    api.fetch.mockReset().mockImplementation(async (path: string) => {
      if (path.includes('/exploration')) return Response.json(ownerExplorationFixture());
      if (path.includes('/preparation-review')) {
        if (fail) throw new Error('offline');
        return Response.json(readValue);
      }
      if (path.includes('/asset-review')) {
        const query = new URL(path, 'http://fixture').searchParams.get('selectedVersionRef');
        return Response.json(assetReviewFixture(query ? JSON.parse(query).version : 'v2'));
      }
      return Response.json(projection);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(mode: 'detail' | 'main' = 'main') {
    await act(async () =>
      root.render(
        mode === 'main' ? (
          <EvolutionProgramSurface programId={PROGRAM_ID} />
        ) : (
          <CapabilityEvolutionProgramDetail
            projection={projection}
            onClose={() => undefined}
            onOpenProgram={openProgram}
          />
        ),
      ),
    );
  }
  async function choose(label: string) {
    const button = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="能力进化旅程"] button')].find(
      (node) => node.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
  }

  it.each([
    'detail',
    'main',
  ] as const)('reads partial published materials and exact public candidates in %s with no Program write', async (mode) => {
    const before = structuredClone(projection);
    await render(mode);
    await choose('准备');
    const panel = host.querySelector('[data-journey-panel="1"]');
    expect(panel?.textContent).toContain('已有环境');
    expect(panel?.textContent).toContain('后续任务计划');
    expect(panel?.textContent).toContain('计划中');
    expect(panel?.textContent).toContain('评估来源维护者');
    expect(panel?.textContent).toContain('独立验证记录');
    expect(panel?.textContent).toContain('尚未接入可核验的反馈');
    await choose('探索进化');
    expect(host.querySelector('[data-journey-panel="2"]')?.textContent).toContain('公开比较未达到阈值');
    const option = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
      node.textContent?.includes('公开选项 A'),
    );
    expect(option).toBeDefined();
    await act(async () => option?.click());
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]?.selectedVersionRef).toEqual(assetRef('v3'));
    if (mode === 'detail') expect(openProgram).toHaveBeenCalledWith(PROGRAM_ID, 'judgment');
    else expect(openProgram).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain('提出目标');
    expect(projection).toEqual(before);
    expect(api.fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    expect(host.querySelector('a[href="/sources/public-decision"]')).not.toBeNull();
  });

  it.each([
    [
      'unknown',
      { ...base, status: 'unknown', blockers: [{ code: 'reader_missing', ownerRef: base.objectRef }] },
      '来源尚待接入',
    ],
    [
      'unpublished',
      {
        ...base,
        status: 'unpublished',
        sourceRef: ownerRef('preparation'),
        readAt: preparation.readAt,
        updatedAt: preparation.updatedAt,
        blockers: [],
      },
      '尚未发布准备材料',
    ],
    ['empty', { ...preparation, groups: [], blockers: [] }, '目录中还没有准备材料'],
    [
      'unavailable',
      { ...base, status: 'unavailable', blockers: [{ code: 'read_failed', ownerRef: base.objectRef }] },
      '准备材料暂时无法读取',
    ],
  ])('distinguishes %s from genuinely empty publication', async (_name, value, copy) => {
    readValue = value;
    await render();
    await choose('准备');
    expect(host.querySelector('[data-journey-panel="1"]')?.textContent).toContain(copy);
  });

  it('network failure clears material content and offers retry instead of claiming empty', async () => {
    fail = true;
    await render();
    await choose('准备');
    expect(host.textContent).toContain('准备材料暂时无法读取');
    expect(host.textContent).not.toContain('已有环境');
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '重新读取材料',
    );
    expect(retry).toBeDefined();
    fail = false;
    await act(async () => retry?.click());
    expect(host.textContent).toContain('已有环境');
  });

  it.each([
    ['running', '运行中'],
    ['completed', '结果已完成'],
    ['awaiting_publication', '材料待发布'],
    ['failed', '运行失败'],
  ] as const)('shows owner activity %s separately from formal candidate/adoption state', async (state, copy) => {
    readValue = {
      ...preparation,
      groups: [
        {
          ...preparation.groups[0],
          items: [
            {
              ...preparation.groups[0].items[0],
              activity: {
                state,
                updatedAt: '2026-09-06T23:58:00.000Z',
                detail: '这是 owner 公开的运行事实，不是正式采用。',
              },
            },
          ],
        },
      ],
    };
    await render();
    await choose('准备');
    expect(host.textContent).toContain(copy);
    expect(host.textContent).toContain('这是 owner 公开的运行事实，不是正式采用。');
    expect(host.querySelector('time[datetime="2026-09-06T23:59:00.000Z"]')).not.toBeNull();
  });

  it('mounts exact inline playback on demand, reports decode failure and retries in the same card', async () => {
    const hash = 'a'.repeat(64);
    const mediaRef = { ...ownerRef(`preparation-media:sha256:${hash}`), version: hash };
    readValue = {
      ...preparation,
      groups: [
        {
          ...preparation.groups[0],
          items: [
            {
              ...preparation.groups[0].items[0],
              resources: [
                {
                  label: '偏侧真实回放',
                  sourceRef: mediaRef,
                  media: { mediaRef, contentType: 'video/mp4', durationSeconds: 20.1 },
                },
              ],
            },
          ],
        },
      ],
    };
    await render();
    await choose('准备');
    const open = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '在页面内播放：偏侧真实回放',
    );
    expect(open).toBeDefined();
    await act(async () => open?.click());
    const video = host.querySelector<HTMLVideoElement>('video[aria-label="偏侧真实回放"]');
    expect(video?.getAttribute('src')).toContain(`/preparation-media/${hash}`);
    expect(video?.controls).toBe(true);
    expect(video?.playsInline).toBe(true);
    expect(video?.preload).toBe('metadata');
    await act(async () => video?.dispatchEvent(new Event('error')));
    expect(host.textContent).toContain('回放加载失败');
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '重试：偏侧真实回放',
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    expect(host.querySelector<HTMLVideoElement>('video[aria-label="偏侧真实回放"]')).not.toBe(video);
  });

  it('links candidate and history dead ends directly to published experiments without inventing a football candidate', async () => {
    await render();
    await choose('探索进化');
    const candidateEntry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '回读准备材料',
    );
    expect(candidateEntry).toBeDefined();
    await act(async () => candidateEntry?.click());
    expect(host.querySelector('[data-journey-panel="1"]')?.textContent).toContain('已有环境');

    const history = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (node) => node.textContent === '更改历史',
    );
    await act(async () => history?.click());
    const historyEntry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === '查看已发布的公开实验与回放',
    );
    expect(historyEntry).toBeDefined();
    await act(async () => historyEntry?.click());
    expect(host.querySelector('[data-journey-panel="1"]')?.textContent).toContain('已有环境');
  });

  it('keeps owner materials directly readable when the production join returns an empty preparation projection', async () => {
    const emptyPreparation = evolutionPreparationFixture();
    for (const section of Object.values(emptyPreparation.sections)) {
      section.current = null;
      section.history = [];
      section.activities = [];
    }
    await act(async () =>
      root.render(<EvolutionMomentContext projection={{ ...projection, preparation: emptyPreparation }} moment={1} />),
    );

    expect(host.querySelector('details.evolution-preparation-related')).toBeNull();
    expect(host.querySelector('section.evolution-preparation-related')?.textContent).toContain('已有环境');
  });
});
