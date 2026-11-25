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

describe('typing independence and composer lane isolation', () => {
  it('does not mutate data-typing when no [data-htype] element exists, and isolates lanes on tick and runner updates', async () => {
    const { dom, w, evaluate } = await bootEngine();
    try {
      const app = w.document.getElementById('app');
      if (!app) throw new Error('missing #app');

      const lanesHtml = (runnerState: string, tickText: string) =>
        '<div class="composer typing-scope">' +
        '<div class="lanes" data-k="lanes:composer.lanes" data-ocontainer="composer.lanes">' +
        '<div class="lane" data-k="lane:run" data-island="lane:composer.lanes:run" data-lane="run">' +
        `<div class="lane-in"><span class="cap">${runnerState} <span class="num" data-tick="run">${tickText}</span></span></div>` +
        '</div>' +
        '<div class="lane" data-k="lane:notice" data-lane="notice">' +
        '<div class="lane-in"><div class="vstack">' +
        '<button type="button" class="cafe-latest" data-island="jump">Latest</button>' +
        '<div class="cnotes" data-island="cnotes" data-rot style="--n:2"><div>A</div><div>B</div></div>' +
        '</div></div>' +
        '</div>' +
        '</div>' +
        '<textarea id="chat-input"></textarea>' +
        '</div>';

      app.innerHTML = lanesHtml('thinking', '9:04:01');
      const scope = app.querySelector('.typing-scope') as HTMLElement;
      const runBefore = app.querySelector('[data-island="lane:composer.lanes:run"]') as HTMLElement;
      const jumpBefore = app.querySelector('[data-island="jump"]') as HTMLElement;
      const cnotesBefore = app.querySelector('[data-island="cnotes"]') as HTMLElement;
      const textarea = app.querySelector('#chat-input') as HTMLTextAreaElement;

      evaluate(`
        for (const el of document.querySelectorAll('[data-island]')) {
          NODE_HTML.set(el, streamVer(el));
        }
      `);

      // 1. Typing with no [data-htype] elements must not set data-typing on .typing-scope
      textarea.value = 'a';
      textarea.dispatchEvent(new w.Event('input', { bubbles: true }));
      expect(scope.hasAttribute('data-typing')).toBe(false);

      // 2. Patch composer on keystroke render when only runner data-tick advanced: every lane & island stays untouched
      let cnotesDetached = false;
      const observer = new w.MutationObserver((records: MutationRecord[]) => {
        for (const r of records) {
          for (const removed of Array.from(r.removedNodes)) {
            if (removed === cnotesBefore || (removed instanceof w.Element && removed.contains(cnotesBefore))) {
              cnotesDetached = true;
            }
          }
        }
      });
      observer.observe(scope, { childList: true, subtree: true });

      evaluate(`{
        const t = document.createElement('template');
        t.innerHTML = ${JSON.stringify(lanesHtml('thinking', '9:04:02'))};
        patchEl(document.querySelector('.typing-scope'), t.content.firstElementChild);
      }`);

      expect(app.querySelector('[data-island="lane:composer.lanes:run"]')).toBe(runBefore);
      expect(app.querySelector('[data-island="jump"]')).toBe(jumpBefore);
      expect(app.querySelector('[data-island="cnotes"]')).toBe(cnotesBefore);

      // 3. Patch composer when runner state changes in lane:run: only lane:run updates, cnotes & jump are never detached
      evaluate(`{
        const t = document.createElement('template');
        t.innerHTML = ${JSON.stringify(lanesHtml('running tool', '9:04:05'))};
        patchEl(document.querySelector('.typing-scope'), t.content.firstElementChild);
      }`);
      await Promise.resolve();
      observer.disconnect();

      expect(app.querySelector('[data-island="lane:composer.lanes:run"]')?.textContent).toContain('running tool');
      expect(app.querySelector('[data-island="jump"]')).toBe(jumpBefore);
      expect(app.querySelector('[data-island="cnotes"]')).toBe(cnotesBefore);
      expect(cnotesDetached).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it('keeps [data-rot] decoupled from data-typing in stream.css', () => {
    const css = readFileSync(path.join('public/pdl/library/css/stream.css'), 'utf8');
    expect(css).toContain('[data-rot]:hover { animation-play-state: paused; }');
    expect(css).not.toContain('.typing-scope[data-typing] [data-rot]');
  });
});
