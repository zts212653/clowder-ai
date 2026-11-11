// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInContext } from 'node:vm';
import { beforeAll, expect, it, vi } from 'vitest';
import loader from '../../../scripts/starry-frame-loader.mjs';
import { scriptSources } from '../runtime';

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');
let document: string;
beforeAll(async () => {
  document = await new Promise<string>((resolve, reject) => {
    loader.call({
      resourcePath: path.resolve('src/starry/entry.tsx'),
      addDependency() {},
      async: () => (error: Error | null, source: string) => {
        if (error) reject(error);
        else resolve(JSON.parse(source.slice('export default '.length, -1)));
      },
    });
  });
}, 60_000);

it('builds a standalone same-origin document without the console shell, session transport or local paths', () => {
  expect(document.includes('<div id="starry-root"></div>')).toBe(true);
  expect(document.includes('/visible-cafe')).toBe(true);
  expect(document.includes('/vendor/app/console-tokens.')).toBe(true);
  expect(document.includes('/api/session')).toBe(false);
  expect(document.includes('PdlAppHost')).toBe(false);
  expect(document.includes('/Users/')).toBe(false);
  expect(document.includes('/workspace/github-lab/')).toBe(false);
});

it('renders the built-in entry through the copied frame block without VM.plug or plugin installation', async () => {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'http://console.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  const evaluate = (source: string) => runInContext(source, dom.getInternalVMContext());
  await new Promise<void>((resolve) => w.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.CSS = { supports: () => true, escape: (value: string) => value };
  w.requestAnimationFrame = () => 0;
  w.document.timeline = { currentTime: 0 };
  w.document.fonts = { ready: Promise.resolve() };
  w.document.getAnimations = () => [];
  w.HTMLElement.prototype.getAnimations = () => [];
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.IntersectionObserver = w.ResizeObserver;
  try {
    for (const script of scriptSources.filter((url) => url.startsWith('/pdl/'))) {
      evaluate(readFileSync(path.join('public', script), 'utf8'));
    }
    evaluate(readFileSync('public/pdl-app/starry.js', 'utf8'));
    expect(evaluate('pdlKids("nav.settings")')).toContain('builtin.starry');
    expect(evaluate('PDL_VIEWS["builtin.starry"].plugin')).toBeUndefined();
    expect(evaluate('pdlEntry("builtin.starry").when')).toBeUndefined();
    const html = evaluate('pdlView("builtin.starry")');
    w.document.getElementById('app').innerHTML = html;
    const frame = w.document.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('src')).toBe('/frames/starry');
    expect(frame.dataset.frameOnMessage).toBe('starryFrameMessage');
    expect(frame.getAttribute('sandbox')).toContain('allow-same-origin');
  } finally {
    dom.window.close();
  }
});

type RequestMessage = {
  type: string;
  id: string;
  method: string;
  path: string;
  body: { settings: Record<string, unknown>; kind: string; active: boolean; previewId: string };
};

it('mounts the reused scene and completes diary engagement and life preview/confirmation entirely over messages', async () => {
  // This checks the built executable and UI actions; jsdom does not verify CSS layout.
  const dom = new JSDOM(document, {
    url: 'http://frame.test/frames/starry',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  Object.assign(w, { Request, Response, TextEncoder, TextDecoder });
  const root = w.document.getElementById('starry-root');
  const errors: string[] = [];
  w.addEventListener('error', (event: { message: string }) => errors.push(event.message));
  const network = vi.fn(async () => new Response(readFileSync('public/visible-cafe/skins/xianxian/skin.json', 'utf8')));
  w.fetch = network;
  const calls: RequestMessage[] = [];
  const defaults = { enabled: false, rhythm: { kind: 'gentle' }, wakeTime: '22:00', timezone: 'UTC' };
  const engagement = { opened: false, reacted: false, openCount: 0 };
  const diary = {
    diaryId: 'dream_one',
    catId: 'fable-5',
    localDate: '2026-07-19',
    headline: '星球日记',
    summary: '今天的记录',
    engagement,
  };
  function result(message: RequestMessage): unknown {
    if (message.path === '/api/cats') {
      return {
        cats: [
          {
            id: 'fable-5',
            displayName: '宪宪',
            carrier: 'cli',
            avatar: '/visible-cafe/skins/xianxian/idle-row.png',
          },
        ],
      };
    }
    if (message.path === '/api/config/cat-order') return { catOrder: ['fable-5'] };
    if (message.path === '/api/threads?limit=30') return { threads: [] };
    if (message.path === '/api/auto-dream/cats/fable-5/life-settings') {
      return { catId: 'fable-5', config: null, defaults };
    }
    if (message.path === '/api/auto-dream/diaries?catId=fable-5&limit=20') {
      return { diaries: [diary], engagementMetrics: null };
    }
    if (message.path === '/api/auto-dream/diaries/dream_one') {
      return { diary: { ...diary, bodyMarkdown: '这页日记的完整正文' }, historicalNotice: '当天的记录' };
    }
    if (message.path === '/api/auto-dream/diaries/dream_one/engagement') {
      return { state: { opened: true, reacted: message.body.kind === 'reaction', openCount: 1 } };
    }
    if (message.path === '/api/auto-dream/cats/fable-5/life-settings/preview') {
      return {
        previewId: 'lifepreview_one',
        catId: 'fable-5',
        settings: message.body.settings,
        nextWakeAt: null,
        weeklyWakeCount: 3,
        costBand: 'low',
        costNotice: '每周 3 次',
        expiresAt: Date.now() + 900_000,
      };
    }
    if (message.path === '/api/auto-dream/life-settings/decision') {
      return {
        status: 'confirmed',
        config: {
          ...defaults,
          catId: 'fable-5',
          nextWakeAt: null,
          weeklyWakeCount: 3,
          costBand: 'low',
          costNotice: '每周 3 次',
          projectionStatus: 'ready',
          revision: 1,
        },
      };
    }
    throw new Error(`Unexpected frame request: ${message.path}`);
  }
  w.postMessage = (message: RequestMessage) => {
    const send = (data: unknown) =>
      w.dispatchEvent(new w.MessageEvent('message', { origin: w.location.origin, source: w, data }));
    if (message.type === 'clowder-frame-ready') send({ type: 'clowder-frame-lifecycle', visible: true });
    if (message.type !== 'clowder-frame-request') return;
    calls.push(message);
    send({ type: 'clowder-frame-response', id: message.id, status: 200, body: result(message) });
  };
  const click = (label: string) => {
    const button = Array.from(w.document.querySelectorAll('button')).find((item) =>
      (item as HTMLButtonElement).textContent?.includes(label),
    ) as HTMLButtonElement;
    expect(button).toBeDefined();
    button.click();
  };
  try {
    w.eval(w.document.querySelector('script[type="module"]').textContent);
    await vi.waitFor(() => expect(w.document.querySelector('.starry-room')).not.toBeNull());
    await vi.waitFor(() => expect(root.textContent).toContain('状态来源'));
    w.document.querySelector('[aria-label^="Cat sprite:"]').click();
    await vi.waitFor(() => expect(root.textContent).toContain('星球日记'));
    click('读全文');
    await vi.waitFor(() => expect(root.textContent).toContain('这页日记的完整正文'));
    click('这页我喜欢');
    await vi.waitFor(() => expect(root.textContent).toContain('已经告诉宪宪'));
    click('生活与作息');
    await vi.waitFor(() => expect(root.textContent).toContain('预览这份生活'));
    click('预览这份生活');
    await vi.waitFor(() => expect(root.textContent).toContain('确认这个作息'));
    expect(calls.filter((message) => message.path.endsWith('/decision'))).toHaveLength(0);
    click('确认这个作息');
    await vi.waitFor(() => expect(root.textContent).toContain('这份生活已经安顿好了'));
    expect(calls.find((message) => message.path.endsWith('/decision'))).toMatchObject({
      method: 'POST',
      body: { previewId: 'lifepreview_one', decision: 'confirm' },
    });
    expect(calls.filter((message) => message.path.endsWith('/engagement')).map((message) => message.body)).toEqual([
      expect.objectContaining({ kind: 'open', clientEventId: expect.any(String) }),
      expect.objectContaining({ kind: 'reaction', clientEventId: expect.any(String), active: true }),
    ]);
    expect(network).toHaveBeenCalledExactlyOnceWith('/visible-cafe/skins/xianxian/skin.json', undefined);
    expect(errors).toEqual([]);
  } finally {
    dom.window.close();
  }
}, 15_000);
