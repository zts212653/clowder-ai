import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
let host: HTMLDivElement;
let root: Root;
let fail: 'network' | 'identity' | 'selection' | 'server' | undefined;
const projection = parseProgramProjection({
  ...programFixture('observing'),
  program: { ...programFixture('observing').program, objectRef },
})!;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fail = undefined;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  api.fetch.mockReset().mockImplementation(async () => {
    if (fail === 'network') throw new TypeError('offline');
    if (fail === 'server') return new Response('Service unavailable', { status: 503 });
    const data = explorationFixture({ withDetail: true });
    if (fail === 'identity') data.objectRef = { ...objectRef, ownerStateRef: 'capability:another' };
    if (fail === 'selection')
      return Response.json(JSON.parse(JSON.stringify(data).replaceAll('source:run', 'source:another-run')));
    return Response.json(data);
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
function Probe() {
  const value = useEvolutionExploration(projection, {
    selectedNodeRef: versionRef,
    selectedExperimentRef: source('run'),
  });
  return (
    <>
      <output>{value.error}</output>
      {value.review && <video aria-label="last verified playback" />}
      <button onClick={value.retry}>retry</button>
    </>
  );
}
it.each([
  'network',
  'server',
] as const)('keeps the same selected playback during a %s refresh failure and recovers in place', async (failure) => {
  await act(async () => root.render(<Probe />));
  const video = host.querySelector('video');
  expect(video).not.toBeNull();
  fail = failure;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(host.querySelector('video')).toBe(video);
  expect(host.textContent).toContain('上次读取成功');
  fail = undefined;
  await act(async () => host.querySelector('button')!.click());
  expect(host.querySelector('video')).toBe(video);
  expect(host.querySelector('output')?.textContent).toBe('');
});
it.each([
  'identity',
  'selection',
] as const)('clears incorrect evidence and exposes a distinct %s failure instead of retaining it as offline data', async (failure) => {
  await act(async () => root.render(<Probe />));
  fail = failure;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(host.querySelector('video')).toBeNull();
  expect(host.textContent).toContain(failure === 'identity' ? '来源身份' : '所选记录');
  const before = api.fetch.mock.calls.length;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(api.fetch.mock.calls).toHaveLength(before);
});
