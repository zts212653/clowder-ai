// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { scriptSources } from '../runtime';
import { builtinThemes } from './builtin-theme';

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');

async function bootTheme(themeId: 'default' | 'v2') {
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
  for (const script of scriptSources.filter((url) => url.startsWith('/pdl/'))) {
    evaluate(readFileSync(path.join('public', script), 'utf8'));
  }
  evaluate(`pdlPackApply(${JSON.stringify(await builtinThemes.read('default'))})`);
  if (themeId !== 'default') {
    const pack = (await builtinThemes.read(themeId)) as { components: Record<string, { js: string[] }> };
    evaluate(`pdlPackApply(${JSON.stringify(pack)})`);
    for (const comp of Object.values(pack.components)) {
      for (const js of comp.js) evaluate(js);
    }
  }
  return { dom, w, evaluate };
}

describe('stream loading dots, passive ticks, and lightbox subtitle', () => {
  it('renders three-dot loading in stream and no placeholder in ticks on default theme', async () => {
    const { dom, w, evaluate } = await bootTheme('default');
    try {
      evaluate(`
        WHO_DATA.member = (id) => ({ id, name: '墨墨', handle: '@momo', color: '#4f8' });
        VM.chatStream = () => ({
          items: Array.from({ length: 40 }, (_, i) => ({
            kind: 'cat',
            mid: 'm-' + i,
            from: 'cat-1',
            html: '<p>msg ' + i + '</p>',
            time: '10:00',
          })),
        });
        VM.chatTicks = () => ({
          older: false,
          ticks: Array.from({ length: 40 }, (_, i) => ({
            mid: 'm-' + i,
            kind: 'cat',
            from: 'cat-1',
            label: 'msg ' + i,
            tip: 'msg ' + i,
          })),
        });
      `);
      const app = w.document.getElementById('app');
      if (!app) throw new Error('missing #app');
      app.innerHTML = evaluate('pdlView("chat.stream") + pdlView("chat.ticks")');
      const stream = w.document.querySelector('[data-own="stream"]');
      const ticks = w.document.querySelector('[data-own="ticks"]');
      expect(stream).not.toBeNull();
      expect(ticks).not.toBeNull();
      expect(stream?.querySelectorAll('[data-units-held] .load-dots > i')).toHaveLength(3);
      expect(stream?.querySelector('.skel')).toBeNull();
      expect(ticks?.querySelector('[data-units-held]')).toBeNull();
      expect(ticks?.querySelector('.skel')).toBeNull();
      expect(ticks?.querySelector('.load-dots')).toBeNull();
      expect(ticks?.querySelectorAll('.cafe-tick[data-mid]')).toHaveLength(40);
    } finally {
      dom.window.close();
    }
  });

  it('renders three-dot loading in v2Stream without skeletons and isolates stream ids', async () => {
    const { dom, w, evaluate } = await bootTheme('v2');
    try {
      evaluate(`
        WHO_DATA.member = (id) => ({ id, name: '墨墨', handle: '@momo', color: '#4f8' });
        VM.chatStream = () => ({
          items: Array.from({ length: 40 }, (_, i) => ({
            kind: 'cat',
            mid: 'v2m-' + i,
            from: 'cat-1',
            html: '<p>msg ' + i + '</p>',
            time: '10:00',
          })),
        });
        VM.guide = () => ({
          items: [{ kind: 'cat', mid: 'guide-1', from: 'cat-1', html: '<p>guide</p>', time: '10:00' }],
        });
      `);
      const app = w.document.getElementById('app');
      if (!app) throw new Error('missing #app');
      app.innerHTML = evaluate('pdlView("chat.stream") + pdlView("guide.messages")');
      const stream = w.document.querySelector('[data-stream="chat"]');
      const theater = w.document.querySelector('[data-stream="theater"]');
      expect(stream).not.toBeNull();
      expect(theater).not.toBeNull();
      expect(stream?.querySelectorAll('[data-units-held] .load-dots > i')).toHaveLength(3);
      expect(stream?.querySelector('.skel')).toBeNull();
      expect(evaluate('Boolean(UNITS_HELD["stream:chat"] && UNITS_HELD["stream:chat"].keys.size > 0)')).toBe(true);
    } finally {
      dom.window.close();
    }
  });

  for (const themeId of ['default', 'v2'] as const) {
    it(`omits missing author and version from media.preview subtitle (${themeId})`, async () => {
      const { dom, w, evaluate } = await bootTheme(themeId);
      try {
        const renderSub = (vm: Record<string, unknown>) => {
          evaluate(`VM.mediaPreview = () => (${JSON.stringify(vm)}); VM.work = () => null;`);
          const app = w.document.getElementById('app');
          if (!app) throw new Error('missing #app');
          app.innerHTML = evaluate('pdlView("media.preview")');
          const el = w.document.querySelector(
            themeId === 'default' ? '.vw-label.below' : 'span.text-xs.text-cafe-muted',
          );
          return el ? (el.textContent?.trim() ?? '') : null;
        };

        const noAuthorNoVer = renderSub({
          target: { kind: 'work', id: 'w1' },
          title: 'photo.png',
          at: 1795171200000,
          index: 1,
          total: 1,
          many: false,
        });
        expect(noAuthorNoVer).toBeTruthy();
        expect(noAuthorNoVer).not.toMatch(/第|版|Version|·/);

        const full = renderSub({
          target: { kind: 'work', id: 'w2' },
          title: 'photo.png',
          author: '墨墨',
          version: 2,
          at: 1795171200000,
          index: 1,
          total: 3,
          many: true,
        });
        expect(full).toContain('墨墨 · 第 2 版 · ');
        expect(full).toContain(' · 1 / 3');

        const onlyVersion = renderSub({
          target: { kind: 'work', id: 'w3' },
          title: 'photo.png',
          version: 4,
          many: false,
        });
        expect(onlyVersion).toBe('第 4 版');

        const allMissing = renderSub({
          target: { kind: 'work', id: 'w4' },
          title: 'photo.png',
          many: false,
        });
        expect(allMissing).toBeNull();
      } finally {
        dom.window.close();
      }
    });
  }
});
