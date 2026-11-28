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

const parkedRecovery = {
  incidents: [{ disposition: 'parked', reasonCode: 'cleanup_unproven', executionRef: 'managed-job-9af4' }],
  pending: false,
  taskId: 'hold-ball-1',
  busy: false,
  canRecheck: true,
};

describe('recovery.notice parity across default and v2 themes', () => {
  for (const themeId of ['default', 'v2'] as const) {
    it(`renders recovery.notice and recoveryRecheck action in execDetail, chat messages, and tasks (${themeId})`, async () => {
      const { dom, w, evaluate } = await bootTheme(themeId);
      try {
        evaluate(`
          WHO_DATA.member = (id) => ({ id, name: '砚砚', handle: '@sol', color: '#4f8' });
          VM.execDetail = () => ({
            id: 'hold-ball-1',
            load: '',
            state: 'running',
            cancelable: true,
            stuck: false,
            inExec: false,
            command: 'node acceptance.mjs',
            elapsed: 120,
            exitCode: null,
            threadId: 'thread-1',
            thread: '跟踪 #1982',
            recovery: ${JSON.stringify(parkedRecovery)},
          });
          VM.chatStream = () => ({
            items: [
              {
                kind: 'cat',
                mid: 'msg-hold-1',
                from: 'cat-eqdvbcxw',
                html: '<p>running command</p>',
                time: '18:22',
                recovery: ${JSON.stringify({ ...parkedRecovery, taskId: 'hold-ball-2', pending: true })},
              },
              {
                kind: 'wake',
                mid: 'msg-wake-1',
                from: 'cat-eqdvbcxw',
                html: '<p>wake notice</p>',
                time: '18:24',
                recovery: ${JSON.stringify({ ...parkedRecovery, taskId: 'hold-ball-3' })},
              },
            ],
          });
          VM.tasks = () => ({
            load: '',
            filter: 'all',
            counts: { all: 1, doing: 1, blocked: 0, todo: 0, done: 0 },
            items: [{
              id: 'task-1',
              title: '验收入口',
              status: 'doing',
              nextStatus: 'done',
              why: '待恢复确认',
              createdBy: 'cat-eqdvbcxw',
              creatorName: '砚砚',
              createdAt: '18:22',
              createdTimestamp: false,
              updatedAt: '18:22',
              updatedTimestamp: false,
              recovery: {
                incidents: [{ disposition: 'needs_attention', reasonCode: 'owner_lost', executionRef: 'job-2' }],
                pending: false,
                canRecheck: false,
              },
            }],
          });
        `);

        const app = w.document.getElementById('app');
        if (!app) throw new Error('missing #app');

        app.innerHTML = evaluate('pdlView("ws.execDetail")');
        expect(app.textContent).toContain('自动恢复已暂停');
        expect(app.textContent).toContain('已停放');
        expect(app.textContent).toContain('cleanup_unproven');
        expect(app.textContent).toContain('managed-job-9af4');
        const execRecheck = app.querySelector('button[data-act="recoveryRecheck"]') as HTMLButtonElement | null;
        expect(execRecheck).not.toBeNull();
        expect(execRecheck?.textContent?.trim()).toBe('重新检查');
        expect(execRecheck?.dataset.taskId).toBe('hold-ball-1');

        const dispatched: Array<{ taskId?: string }> = [];
        evaluate(`
          globalThis.__recheckCalls = [];
          A.recoveryRecheck = (d) => { globalThis.__recheckCalls.push(d); };
        `);
        execRecheck?.click();
        dispatched.push(...(evaluate('globalThis.__recheckCalls') as Array<{ taskId?: string }>));
        expect(dispatched).toMatchObject([{ act: 'recoveryRecheck', taskId: 'hold-ball-1' }]);

        app.innerHTML = evaluate('pdlView("chat.stream")');
        expect(app.textContent).toContain('正在恢复');
        const streamButtons = [...app.querySelectorAll('button[data-act="recoveryRecheck"]')] as HTMLButtonElement[];
        expect(streamButtons.map((btn) => btn.dataset.taskId)).toEqual(['hold-ball-2', 'hold-ball-3']);

        if (themeId === 'default') evaluate(`A.fold({ f: 'row', l: 'tasks', k: 'task-1' })`);
        app.innerHTML = evaluate('pdlView("ws.tasks")');
        expect(app.textContent).toContain('自动恢复已暂停');
        expect(app.textContent).toContain('需要检查');
        expect(app.textContent).toContain('owner_lost');
        expect(app.textContent).toContain('job-2');

        evaluate(`S.lang = 'en'`);
        app.innerHTML = evaluate('pdlView("ws.execDetail")');
        expect(app.textContent).toContain('Automatic recovery paused');
        expect(app.textContent).toContain('Parked');
        expect(app.querySelector('button[data-act="recoveryRecheck"]')?.textContent?.trim()).toBe('Recheck');
      } finally {
        dom.window.close();
      }
    });
  }
});
