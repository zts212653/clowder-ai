import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  explorationFixture,
  objectRef,
  source,
  versionRef,
} from '../../../../../api/test/capability-evolution-exploration.helper.mjs';
import { parseProgramProjection } from '../evolution-program-projection';
import { useEvolutionExploration } from '../exploration/exploration-resource';
import { programFixture } from './evolution-fixtures';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: api.fetch }));

it('a late old-selection response cannot replace the newer catalogue or result', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const value = programFixture('observing');
  value.program.objectRef = objectRef;
  const projection = parseProgramProjection(value);
  if (!projection) throw new Error('invalid fixture');
  const a = explorationFixture({ withDetail: true });
  a.nodes[0]!.title = '旧版 A';
  const b = JSON.parse(
    JSON.stringify(a).replaceAll('source:method', 'source:method-b').replaceAll('source:run', 'source:run-b'),
  );
  b.nodes[0].title = '新版 B';
  b.readAt = '2026-09-09T15:00:00.000Z';
  let release: ((response: Response) => void) | undefined;
  api.fetch.mockImplementation(async (path: string) =>
    path.includes('method-b')
      ? Response.json(b)
      : new Promise<Response>((resolve) => {
          release = resolve;
        }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Probe({ next = false }: { next?: boolean }) {
    const result = useEvolutionExploration(projection!, {
      selectedNodeRef: { ...versionRef, ownerStateRef: next ? 'source:method-b' : 'source:method' },
      selectedExperimentRef: source(next ? 'run-b' : 'run'),
    });
    return (
      <output>
        {result.catalog?.nodes[0]?.title ?? '读取中'} · {result.review?.nodes[0]?.title}
      </output>
    );
  }
  try {
    await act(async () => root.render(<Probe />));
    expect(release).toBeDefined();
    await act(async () => root.render(<Probe next />));
    expect(host.textContent).toContain('新版 B');
    await act(async () => release!(Response.json(a)));
    expect(host.textContent).toBe('新版 B · 新版 B');
  } finally {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});

it('a same-selection background refresh keeps the mounted record until its new read resolves', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const value = programFixture('observing');
  value.program.objectRef = objectRef;
  const projection = parseProgramProjection(value);
  if (!projection) throw new Error('invalid fixture');
  const publication = explorationFixture({ withDetail: true });
  let refresh = false;
  let release: ((response: Response) => void) | undefined;
  api.fetch.mockImplementation(async () =>
    refresh
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : Response.json(publication),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Probe() {
    const result = useEvolutionExploration(projection!, {
      selectedNodeRef: versionRef,
      selectedExperimentRef: source('run'),
    });
    return result.review ? <video aria-label="mounted record" /> : <p>loading</p>;
  }
  try {
    await act(async () => root.render(<Probe />));
    const video = host.querySelector('video');
    expect(video).not.toBeNull();
    refresh = true;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(host.querySelector('video')).toBe(video);
    await act(async () => release!(Response.json(publication)));
    expect(host.querySelector('video')).toBe(video);
  } finally {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
