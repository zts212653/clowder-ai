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
import { DEFAULT_EXPLORATION } from '../exploration/exploration-reading';
import { EvolutionMomentContext } from '../journey/EvolutionMomentContext';
import { programFixture } from './evolution-fixtures';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));

describe('exploration in the actual journey surface', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    useEvolutionReading.setState({ programs: {} });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    api.fetch.mockReset().mockImplementation(async (path: string) => {
      const url = new URL(path, 'https://cafe.invalid');
      if (!url.pathname.endsWith('/exploration')) return new Response('{}', { status: 404 });
      return Response.json(explorationFixture({ withDetail: url.searchParams.has('selectedExperimentRef') }));
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it('shows unavailable owner truth beside a readable archive instead of implying no formal versions exist', async () => {
    const value = programFixture('observing');
    value.program.objectRef = objectRef;
    const projection = parseProgramProjection(value)!;
    const publication = {
      ...explorationFixture(),
      nodes: [
        {
          kind: 'public_archive',
          nodeRef: source('public-v8'),
          title: '公开 v8',
          summary: '公开归档',
          sourceRef: source('archive'),
          changes: [],
          parentEdges: [],
        },
      ],
      experiments: [],
      details: [],
      blockers: [
        { code: 'owner_version_review_unavailable', ownerRef: objectRef },
        { code: 'target_drift', ownerRef: objectRef },
      ],
    };
    api.fetch.mockImplementation(async (path: string) =>
      path.includes('/exploration') ? Response.json(publication) : new Response('{}', { status: 404 }),
    );
    await act(async () =>
      root.render(<EvolutionMomentContext projection={projection} moment={2} explorationMode="workspace" />),
    );
    expect(host.querySelector('[aria-label="探索来源待确认"]')?.textContent).toContain('正式版本暂不可读');
    expect(host.textContent).toContain('版本来源的目标已变化');
    expect(host.textContent).toContain('公开 v8');
    const owner = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => entry.textContent === '本项目版本',
    );
    expect(owner?.disabled).toBe(true);
  });
  it('recovers from an unavailable persisted node without losing the draft or requiring storage cleanup', async () => {
    const value = programFixture('observing');
    value.program.objectRef = objectRef;
    const projection = parseProgramProjection(value)!;
    useEvolutionReading.getState().update(value.program.programId, {
      exploration: {
        ...DEFAULT_EXPLORATION,
        selectedNodeRef: source('removed-archive'),
        draft: { intent: 'explore', text: 'keep this draft' },
      },
    });
    await act(async () =>
      root.render(<EvolutionMomentContext projection={projection} moment={2} explorationMode="workspace" />),
    );
    const recovery = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (entry) => entry.textContent === '回到可用版本',
    );
    expect(recovery).toBeDefined();
    await act(async () => recovery!.click());
    expect(host.querySelector('[data-testid="evolution-exploration-workspace"]')).not.toBeNull();
    expect(host.querySelector('textarea')?.value).toBe('keep this draft');
  });
  it('finds a version, reads its actual input/output and preserves an unfamiliar draft', async () => {
    const value = programFixture('observing');
    value.program.objectRef = objectRef;
    const projection = parseProgramProjection(value);
    if (!projection) throw new Error('invalid program');
    await act(async () => {
      root.render(
        <EvolutionMomentContext projection={projection} moment={2} {...{ explorationMode: 'workspace' as const }} />,
      );
    });
    expect(host.querySelector('[aria-label="版本谱系"]')).not.toBeNull();
    expect(host.textContent).toContain('未登录读取');
    expect(host.textContent).toContain('401');
    const input = host.querySelector<HTMLTextAreaElement>('[aria-label="继续探索的想法"]');
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        '检查未见过的重定向 sentinel-9k',
      );
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useEvolutionReading.getState().programs[projection.program.programId]?.exploration?.draft.text).toBe(
      '检查未见过的重定向 sentinel-9k',
    );
    expect(
      useEvolutionReading.getState().programs[projection.program.programId]?.exploration?.draft.binding?.nodeRef
        .ownerStateRef,
    ).toBe('source:method');
  });
});

describe('draft completion race', () => {
  it('does not erase newer input when an older request finally returns', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    useEvolutionReading.setState({ programs: {} });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const value = {
      ...programFixture('observing'),
      origin: { threadId: 'thread-owner', title: '代码', createdByCatId: 'codex-sol' },
    };
    value.program.objectRef = objectRef;
    const projection = parseProgramProjection(value);
    if (!projection) throw new Error('invalid program');
    let deliver: ((response: Response) => void) | undefined;
    api.fetch.mockReset().mockImplementation(async (path: string) => {
      if (path === '/api/cats') return Response.json({ cats: [{ id: 'codex-sol' }] });
      if (path === '/api/messages')
        return new Promise<Response>((resolve) => {
          deliver = resolve;
        });
      if (path.includes('/asset-review')) return new Response('{}', { status: 404 });
      if (path.includes('/exploration?'))
        return Response.json(
          explorationFixture({
            withDetail: new URL(path, 'https://cafe.invalid').searchParams.has('selectedExperimentRef'),
          }),
        );
      return Response.json(value);
    });
    try {
      await act(async () =>
        root.render(<EvolutionMomentContext projection={projection} moment={2} explorationMode="workspace" />),
      );
      const input = host.querySelector<HTMLTextAreaElement>('textarea')!;
      const type = async (text: string) =>
        act(async () => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      await type('第一条已经提交的问题');
      await act(async () => {
        host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(deliver).toBeDefined();
      await type('在等待期间写下的新想法 sentinel-next');
      await act(async () => deliver!(Response.json({ status: 'queued', userMessageId: 'real-test-receipt' })));
      expect(useEvolutionReading.getState().programs[projection.program.programId]?.exploration?.draft.text).toBe(
        '在等待期间写下的新想法 sentinel-next',
      );
    } finally {
      act(() => root.unmount());
      host.remove();
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});
