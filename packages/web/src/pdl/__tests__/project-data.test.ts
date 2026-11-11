import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { request } from '../owner-api';
import { useOpsBindings } from '../useOpsBindings';
import { fixtureData } from './chat-fixture';
import { cleanup, renderHook, waitFor } from './hook-host';
import { createOwnerConsole } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
afterEach(async () => {
  await cleanup();
  vi.resetAllMocks();
});

it('holds each raw binding independently and reports the same failed source only after recovery', () => {
  const engine = { dataError: vi.fn(), dataOk: vi.fn() };
  const console = createOwnerConsole();
  Object.assign(console.context, engine);
  const healthy = { items: ['owner data'] };
  const failure = new Error('source unavailable');
  console.push({ healthy, broken: null, readFailures: { broken: failure } });
  const held = console.read("projectData('healthy')");
  expect(held).toEqual(healthy);
  expect(console.read("projectData('broken')")).toBeNull();
  expect(engine.dataError).toHaveBeenCalledOnce();
  console.push({
    healthy,
    broken: null,
    readFailures: { broken: failure },
  });
  expect(console.read("projectData('healthy')")).toBe(held);
  expect(engine.dataError).toHaveBeenCalledOnce();
  console.push({ broken: { items: [] }, readFailures: {} });
  expect(console.read("projectData('broken').items")).toEqual([]);
  expect(engine.dataOk).toHaveBeenCalledWith('broken');
  console.push({ broken: null, readFailures: { broken: new Error('source unavailable') } });
  expect(engine.dataError).toHaveBeenCalledTimes(2);
  expect(console.read("projectData('healthy')")).toBe(held);
});

it('routes an unpresented API error envelope through the held boundary and never merges it as owner data', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'owner unavailable' })));
  const failedRead = await request('/api/owner').catch((error: Error) => error);
  expect(failedRead).toMatchObject({ name: 'PdlReadError', message: 'owner unavailable' });
  const engine = { dataError: vi.fn(), dataOk: vi.fn() };
  const console = createOwnerConsole();
  Object.assign(console.context, engine);
  const input = { owner: null, healthy: { title: 'Owner record' }, readFailures: { owner: failedRead } };
  console.push(input);
  expect(console.read("projectData('owner')")).toBeNull();
  expect(console.read("projectData('healthy')")).toEqual({ title: 'Owner record' });
  console.push(input);
  expect(engine.dataError).toHaveBeenCalledOnce();
  expect(engine.dataError).toHaveBeenLastCalledWith('owner', failedRead);
  expect(engine.dataOk).not.toHaveBeenCalledWith('owner');
});

it('keeps the existing error/retry state for a real owner read and adds no duplicate toast', async () => {
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'owner unavailable' })));
  const ui = {
    opsView: 'daemon',
    obsV: 'overview',
    lbRange: 'all',
    toolCat: '',
    toolType: '',
    toolRange: 7,
    rpReview: false,
    rpArch: false,
  };
  const { result } = renderHook(() => useOpsBindings(fixtureData(), ui, true));
  const engine = { dataError: vi.fn(), dataOk: vi.fn() };
  const console = createOwnerConsole({ ws: ui });
  Object.assign(console.context, engine);
  const read = () => {
    console.push({ ops: result.current.data, healthy: { title: 'Other owner' } });
    return {
      ops: console.read('projectOps()'),
      healthy: console.read("projectData('healthy')"),
    };
  };
  await waitFor(() => expect(read().ops.cafeWsOps.load).toBe('error'));
  expect(read()).toMatchObject({ ops: { cafeWsOps: { load: 'error' } }, healthy: { title: 'Other owner' } });
  read();
  expect(engine.dataError).not.toHaveBeenCalled();
  expect(engine.dataOk).not.toHaveBeenCalledWith('ops');
});
