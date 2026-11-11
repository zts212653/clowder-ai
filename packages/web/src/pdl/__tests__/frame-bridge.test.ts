import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { config, middleware } from '../../middleware';
import { apiFetch as childFetch, fetch as injectedFetch } from '../../starry/frame-api';
import { frameRequest } from '../frame-bridge';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

let frame: HTMLIFrameElement;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const request = (path: string, method = 'GET', body?: unknown) => ({
  type: 'clowder-frame-request',
  id: 'request-1',
  method,
  path,
  body,
});
const eventFromFrame = (origin = window.location.origin, source: Window = frame.contentWindow!) =>
  new MessageEvent('message', { origin, source });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  frame = document.createElement('iframe');
  frame.dataset.frameKey = 'starry';
  document.body.append(frame);
});
afterEach(() => {
  frame.remove();
  vi.restoreAllMocks();
});

describe('built-in frame route permissions', () => {
  it.each([
    ['GET', '/api/cats'],
    ['GET', '/api/config/cat-order'],
    ['GET', '/api/threads?limit=30'],
    ['GET', '/api/auto-dream/cats/fable-5/life-settings'],
    ['GET', '/api/auto-dream/cats/%E5%AE%AA%E5%AE%AA.v2/life-settings'],
    ['POST', '/api/auto-dream/cats/fable-5/life-settings/preview'],
    ['POST', '/api/auto-dream/life-settings/decision'],
    ['GET', '/api/auto-dream/diaries?catId=fable-5&limit=20'],
    ['GET', '/api/auto-dream/diaries/dream_one'],
    ['POST', '/api/auto-dream/diaries/dream_one/engagement'],
  ])('allows exactly the existing %s %s capability', async (method, path) => {
    vi.mocked(apiFetch).mockResolvedValue(response({ saved: true }));
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const body = method === 'POST' ? { decision: 'confirm', previewId: 'preview-1' } : undefined;
    await frameRequest(request(path, method, body), frame, eventFromFrame());
    expect(apiFetch).toHaveBeenCalledExactlyOnceWith(path, {
      method,
      ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    expect(post).toHaveBeenCalledWith(
      { type: 'clowder-frame-response', id: 'request-1', status: 200, body: { saved: true } },
      window.location.origin,
    );
  });

  it.each([
    ['POST', '/api/cats'],
    ['GET', '/api/session'],
    ['GET', '/api/cats?all=true'],
    ['GET', '/api/config/cat-order/extra'],
    ['GET', '/api/threads?limit=100'],
    ['GET', '/api/threads?limit=30&userId=other'],
    ['DELETE', '/api/auto-dream/diaries/dream_one'],
    ['GET', '/api/auto-dream/diaries?catId=fable-5&limit=100'],
    ['GET', '/api/auto-dream/cats/../life-settings'],
    ['GET', '/api/auto-dream/cats/%2e%2e/life-settings'],
    ['GET', '/api/auto-dream/cats/%2f/life-settings'],
    ['GET', 'https://other.test/api/cats'],
    ['GET', '//other.test/api/cats'],
  ])('denies %s %s without making a host request', async (method, path) => {
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    await frameRequest(request(path, method), frame, eventFromFrame());
    expect(apiFetch).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'request-1', status: 403 }),
      window.location.origin,
    );
  });

  it('ignores an untrusted origin, another window and malformed envelopes', async () => {
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    await frameRequest(request('/api/cats'), frame, eventFromFrame('https://other.test'));
    await frameRequest(request('/api/cats'), frame, eventFromFrame(window.location.origin, window));
    await frameRequest({ type: 'clowder-frame-request', path: '/api/cats' }, frame, eventFromFrame());
    await frameRequest(null, frame, eventFromFrame());
    expect(apiFetch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

it('round trips the child request id, JSON body and refused HTTP response through the host session client', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ error: 'preview_expired' }, 409));
  const childPost = vi.spyOn(window.parent, 'postMessage').mockImplementation((data) => {
    void frameRequest(data, frame, eventFromFrame());
  });
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((data) => {
    window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin, source: window.parent }));
  });
  const body = { previewId: 'server-preview', decision: 'confirm' };
  const reply = await childFetch('/api/auto-dream/life-settings/decision', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  expect(reply.status).toBe(409);
  expect(await reply.json()).toEqual({ error: 'preview_expired' });
  expect(childPost).toHaveBeenCalledWith(
    expect.objectContaining({ id: expect.any(String), method: 'POST', body }),
    window.location.origin,
  );
  expect(apiFetch).toHaveBeenCalledExactlyOnceWith('/api/auto-dream/life-settings/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
});

it('returns transport errors over the bridge', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new Error('connection_lost'));
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  await frameRequest(request('/api/cats'), frame, eventFromFrame());
  expect(post).toHaveBeenCalledWith(
    { type: 'clowder-frame-response', id: 'request-1', status: 502, body: { error: 'connection_lost' } },
    window.location.origin,
  );
});

it('finishes an in-flight reply against its original window when the frame closes', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  const pending = frameRequest(request('/api/cats'), frame, eventFromFrame());
  frame.remove();
  finish(response({ cats: [] }));
  await pending;
  expect(post).toHaveBeenCalledWith(
    { type: 'clowder-frame-response', id: 'request-1', status: 200, body: { cats: [] } },
    window.location.origin,
  );
});

it('matches replies by id and ignores forged parent replies', async () => {
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  const cats = childFetch('/api/cats');
  const order = childFetch('/api/config/cat-order');
  const [catsId, orderId] = post.mock.calls.map(([message]) => message.id);
  expect(catsId).not.toBe(orderId);
  const send = (id: string, origin = window.location.origin, source: Window = window.parent) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        source,
        data: { type: 'clowder-frame-response', id, status: 200, body: { id } },
      }),
    );
  let resolved = false;
  void cats.then(() => {
    resolved = true;
  });
  send(catsId, 'https://other.test');
  send(catsId, window.location.origin, frame.contentWindow!);
  send('unknown-id');
  await Promise.resolve();
  expect(resolved).toBe(false);
  send(orderId);
  expect(await (await order).json()).toEqual({ id: orderId });
  send(catsId);
  expect(await (await cats).json()).toEqual({ id: catsId });
});

it('keeps static asset URLs native while injected API fetches use the same request bridge', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ id: 'skin' }));
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  await injectedFetch('/visible-cafe/skins/xianxian/skin.json');
  expect(network).toHaveBeenCalledExactlyOnceWith('/visible-cafe/skins/xianxian/skin.json', undefined);
  expect(post).not.toHaveBeenCalled();
  const reply = injectedFetch('/api/cats');
  const id = post.mock.calls[0][0].id;
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: window.location.origin,
      source: window.parent,
      data: { type: 'clowder-frame-response', id, status: 200, body: { cats: [] } },
    }),
  );
  expect(await (await reply).json()).toEqual({ cats: [] });
  expect(network).toHaveBeenCalledTimes(1);
});

it('binds the theme built-in frame without registering another entry or installed-plugin condition', () => {
  const context = createContext({
    pdlRegister: vi.fn(),
    tc: (key: string) => key,
    A: {},
    VM: {},
    onRender: vi.fn(),
    document: { addEventListener: vi.fn() },
  });
  const theme = readFileSync('public/pdl/theme/default/pdl.js', 'utf8');
  const modules = JSON.parse(`[${theme.slice(theme.indexOf('pdlThemeLoad(') + 13, theme.lastIndexOf(')'))}]`)[0]
    .modules;
  runInContext(
    'pdlRegister(' + JSON.stringify(modules.find((m: { id: string }) => m.id === 'builtin.starry')) + ')',
    context,
  );
  runInContext(readFileSync('public/pdl-app/starry.js', 'utf8'), context);
  expect(context.pdlRegister).toHaveBeenCalledOnce();
  expect(runInContext('VM.starryFrame().src', context)).toBe('/frames/starry');
  const [fragment, plugin] = context.pdlRegister.mock.calls[0];
  expect(plugin).toBeUndefined();
  expect(fragment.inserts).toHaveLength(1);
  expect(fragment.inserts[0]).toMatchObject({
    id: 'builtin.starry',
    anchor: 'nav.settings',
    at: 'inside',
    node: { open: { node: 'builtin.starry', anchor: 'builtin.starry', depth: 65536, as: 'cover' } },
  });
  expect(fragment.views['builtin.starry'].route).toBe('starry');
  expect(fragment.views['builtin.starry'].blocks[0]).toMatchObject({
    type: 'frame',
    src: '$.src',
    on: { message: 'starryFrameMessage' },
  });
});

it('overrides the console deny policy only for the standalone frontend document', () => {
  expect(config.matcher).toBe('/frames/starry');
  const response = middleware();
  expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(response.headers.get('content-security-policy')).toBe(
    "frame-ancestors 'self'; script-src 'self' 'unsafe-inline'; object-src 'none'",
  );
});
