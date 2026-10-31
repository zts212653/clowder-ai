import { evolutionExplorationReviewV1Schema } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  explorationFixture,
  objectRef,
  source,
} from '../../../../../api/test/capability-evolution-exploration.helper.mjs';
import { parseProgramProjection } from '../evolution-program-projection';
import { useEvolutionReading } from '../evolution-reading-state';
import { ExplorationPairedResults } from '../exploration/ExplorationPairedResults';
import { compareExplorationRecords } from '../exploration/exploration-comparison';
import { DEFAULT_EXPLORATION } from '../exploration/exploration-reading';
import { EvolutionMomentContext } from '../journey/EvolutionMomentContext';
import { programFixture } from './evolution-fixtures';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));

describe('v2 exploration reading', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    useEvolutionReading.setState({ programs: {} });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
    api.fetch.mockReset().mockImplementation(async (path: string) => {
      const url = new URL(path, 'https://cafe.invalid');
      return url.pathname.endsWith('/exploration')
        ? Response.json(explorationFixture({ withDetail: url.searchParams.has('selectedExperimentRef') }))
        : new Response('{}', { status: 404 });
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function showProgram() {
    const value = programFixture('observing');
    value.program.objectRef = objectRef;
    const projection = parseProgramProjection(value)!;
    await act(async () =>
      root.render(<EvolutionMomentContext projection={projection} moment={2} explorationMode="workspace" />),
    );
    return value.program.programId;
  }

  it('opens the v2 map by default and keeps adoption truth separate from the reading selection', async () => {
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    const programId = await showProgram();
    const toggle = host.querySelector<HTMLButtonElement>('[aria-expanded="true"]');
    expect(toggle?.textContent).toBe('收起地图');
    expect(host.textContent).toContain('当前采用：review-method');
    expect(host.textContent).toContain('来源当前版本：待来源核验');
    expect(host.textContent).toContain('正在读：身份守卫 v1');
    await act(async () => toggle?.click());
    expect(useEvolutionReading.getState().programs[programId]?.exploration?.lineageCollapsed).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[aria-expanded="false"]')?.textContent).toBe('展开地图');
    expect(host.textContent).toContain('当前采用：review-method');
    expect(host.textContent).toContain('来源当前版本：待来源核验');
  });

  it('keeps independently rooted public archives and owner versions together in the v2 map', async () => {
    localStorage.setItem('cat-cafe:shell-presentation', 'v2');
    api.fetch.mockImplementation(async (path: string) => {
      const url = new URL(path, 'https://cafe.invalid');
      if (!url.pathname.endsWith('/exploration')) return new Response('{}', { status: 404 });
      const review = evolutionExplorationReviewV1Schema.parse(
        explorationFixture({ withDetail: url.searchParams.has('selectedExperimentRef') }),
      );
      if (review.status !== 'resolved') throw Error('unresolved fixture');
      review.nodes.push({
        kind: 'public_archive',
        nodeRef: source('archive-root'),
        sourceRef: source('archive-publication'),
        title: '独立公开归档',
        summary: '父边未登记；不归到所选正式版本',
        parentEdges: [],
        changes: [],
      });
      review.nodes.push({
        kind: 'public_archive',
        nodeRef: source('archive-child'),
        sourceRef: source('child-publication'),
        title: '已登记的公开派生',
        summary: '依据已发布父边，不以实验时序推断',
        changes: [],
        parentEdges: [{ parentNodeRef: source('archive-root'), sourceRef: source('derivation-proof') }],
      });
      return Response.json(review);
    });
    await showProgram();
    expect(host.querySelector('button[aria-label="阅读 身份守卫 v1"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="阅读 独立公开归档"]')).not.toBeNull();
    expect(host.textContent).toContain('本项目版本 · 1');
    expect(host.textContent).toContain('公开归档 · 2');
    expect(host.textContent).toContain('派生自：独立公开归档');
    expect(host.textContent).toContain('目录没登记部分版本是从哪版改来的，所以不连线');
    expect(host.textContent).not.toContain('未登记父边');
    expect(host.textContent).toContain('当前采用：review-method');
    expect(host.textContent).toContain('来源当前版本：待来源核验');
    const full = [...host.querySelectorAll('button')].find((button) => button.textContent === '完整谱系');
    expect(full).toBeDefined();
    await act(async () => full!.click());
    expect(host.querySelector('dialog button[aria-label="阅读 已登记的公开派生"]')).not.toBeNull();
  });

  it('keeps a known counterexample visible in v2 when the main comparison filters to improvements', async () => {
    const review = evolutionExplorationReviewV1Schema.parse(explorationFixture({ withDetail: true }));
    if (review.status !== 'resolved' || review.details[0]?.status !== 'resolved') throw Error('unresolved fixture');
    const experiment = { ...review.experiments[0]!, recordCount: 3 };
    const template = review.details[0].records[0]!;
    const right = {
      experiment,
      records: (['satisfied', 'violated', 'unknown'] as const).map((status, index) => ({
        ...template,
        caseId: `case-${index}`,
        label: ['身份守卫已恢复', '跨项目读取仍泄漏', '尚未裁定'][index]!,
        inputRef: source(`input-${index}`),
        recordRef: source(`right-${index}`),
        media: [
          {
            mediaRef: source(`case-video-${index}`, 'a'.repeat(64)),
            kind: 'video' as const,
            contentType: 'video/mp4' as const,
            provenance: 'original' as const,
            label: '本次原件',
            sourceRecordRef: template.evidenceRef,
          },
        ],
        result: { status, label: status },
      })),
    };
    const left = {
      experiment: { ...experiment, experimentRef: source('before') },
      records: right.records.map((record, index) => ({
        ...record,
        recordRef: source(`left-${index}`),
        experimentRef: source('before'),
        result: { status: index === 0 ? ('violated' as const) : ('satisfied' as const), label: '对照结果' },
      })),
    };
    await act(async () =>
      root.render(
        <ExplorationPairedResults
          programId={review.programRef.ownerStateRef}
          left={left}
          right={right}
          result={compareExplorationRecords(left, right, 'full')}
          reading={{ ...DEFAULT_EXPLORATION, caseFilter: 'improved', selectedCaseId: 'case-0' }}
          onChange={() => {}}
          onRetry={() => {}}
          v2
        />,
      ),
    );
    expect(host.querySelector('.exploration-pair-focus h3')?.textContent).toBe('身份守卫已恢复');
    const counterexample = host.querySelector('[aria-label="本次判据未通过的记录"]');
    expect(counterexample).not.toBeNull();
    expect(counterexample?.textContent).toContain('跨项目读取仍泄漏');
    expect(counterexample?.querySelector('[data-media-record]')?.getAttribute('data-media-record')).toContain('left-1');
    expect(counterexample?.textContent).not.toContain('尚未裁定');
  });
});
