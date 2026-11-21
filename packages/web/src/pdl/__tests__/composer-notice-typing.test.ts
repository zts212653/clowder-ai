// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { scriptSources } from '../runtime';

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');

async function bootEngine() {
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
  return { dom, w, evaluate };
}

describe('composer notices remain steady while typing', () => {
  it('ignores data-tick clock text in streamVer and keeps data-typing across patchEl', async () => {
    const { dom, w, evaluate } = await bootEngine();
    try {
      const app = w.document.getElementById('app');
      if (!app) throw new Error('missing #app');
      app.innerHTML =
        '<div class="composer typing-scope">' +
        '<div class="lanes" data-island="lanes:composer.lanes">' +
        '<span class="num" data-tick="run">9:04:01</span>' +
        '<div class="cnotes" data-island="cnotes" data-rot style="--n:2"><div>A</div><div>B</div></div>' +
        '</div>' +
        '<textarea id="chat-input"></textarea>' +
        '</div>';
      const scope = app.querySelector('.typing-scope') as HTMLElement;
      const lanesBefore = app.querySelector('[data-island="lanes:composer.lanes"]') as HTMLElement;
      const cnotesBefore = app.querySelector('[data-island="cnotes"]') as HTMLElement;

      evaluate(`
        NODE_HTML.set(document.querySelector('[data-island="lanes:composer.lanes"]'), streamVer(document.querySelector('[data-island="lanes:composer.lanes"]')));
        NODE_HTML.set(document.querySelector('[data-island="cnotes"]'), streamVer(document.querySelector('[data-island="cnotes"]')));
      `);

      // Simulate typing event setting data-typing="1"
      scope.dataset.typing = '1';

      // Patch composer where only the runner's data-tick clock advanced (9:04:01 -> 9:04:02)
      evaluate(`
        const t = document.createElement('template');
        t.innerHTML = '<div class="composer typing-scope">'
          + '<div class="lanes" data-island="lanes:composer.lanes">'
          + '<span class="num" data-tick="run">9:04:02</span>'
          + '<div class="cnotes" data-island="cnotes" data-rot style="--n:2"><div>A</div><div>B</div></div>'
          + '</div>'
          + '<textarea id="chat-input">a</textarea>'
          + '</div>';
        patchEl(document.querySelector('.typing-scope'), t.content.firstElementChild);
      `);

      expect(app.querySelector('.typing-scope')).toBe(scope);
      expect(scope.dataset.typing).toBe('1');
      expect(app.querySelector('[data-island="lanes:composer.lanes"]')).toBe(lanesBefore);
      expect(app.querySelector('[data-island="cnotes"]')).toBe(cnotesBefore);
    } finally {
      dom.window.close();
    }
  });

  it('pauses [data-rot] notice rotation while .typing-scope has data-typing', () => {
    const css = readFileSync(path.join('public/pdl/library/css/stream.css'), 'utf8');
    expect(css).toMatch(
      /\[data-rot\]:hover,\s*\.typing-scope\[data-typing\]\s+\[data-rot\]\s*\{\s*animation-play-state:\s*paused;/,
    );
  });
});
