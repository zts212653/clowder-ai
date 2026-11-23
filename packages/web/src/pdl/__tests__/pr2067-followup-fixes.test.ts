// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { chatModels } from '../chat-models';
import { scriptSources } from '../runtime';
import type { ChatPort } from '../types';
import { builtinThemes, defaultThemePdl } from './builtin-theme';
import { fixtureData, fixtureInput, fixtureSidebar, fixtureUi } from './chat-fixture';

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');

async function bootConsole(
  themeId: 'default' | 'v2',
  options: {
    threadId?: string;
    configure?: (data: ReturnType<typeof fixtureData>, sidebar: ReturnType<typeof fixtureSidebar>) => void;
  } = {},
) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'https://pdl.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  const ctx = dom.getInternalVMContext();
  const evalIn = (code: string) => runInContext(code, ctx);
  await new Promise<void>((resolve) => w.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  w.document.timeline = { currentTime: 0 };
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.CSS = { escape: (s: string) => s, supports: () => true };
  w.HTMLElement.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.showPopover = () => {};
  w.HTMLElement.prototype.hidePopover = () => {};
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.IntersectionObserver = w.ResizeObserver;
  w.document.getAnimations = () => [];
  w.document.fonts = { ready: Promise.resolve() };
  w.document.documentElement.style.setProperty('--hold-toast', defaultThemePdl().tokens.base['--hold-toast']);
  const origAppend = w.document.head.appendChild.bind(w.document.head);
  w.document.head.appendChild = ((node: Node) => {
    const tag = (node as Element).tagName;
    if (tag === 'STYLE') return node;
    const out = origAppend(node);
    if (tag === 'SCRIPT' && node.textContent) {
      runInContext(node.textContent, ctx);
    }
    return out;
  }) as typeof w.document.head.appendChild;
  for (const source of scriptSources) {
    runInContext(readFileSync(path.join(process.cwd(), 'public', source), 'utf8'), ctx, { filename: source });
  }

  const data = fixtureData();
  data.cats.push({
    ...data.cats[0],
    id: 'momo',
    displayName: '墨墨',
    nickname: '墨墨',
    mentionPatterns: ['@momo'],
    avatar: '',
    color: { primary: '#4d7fa3', secondary: '#eef5fa' },
  });
  if (options.threadId) data.threadId = options.threadId;

  const ui = fixtureUi();
  const sidebar = fixtureSidebar(data);
  options.configure?.(data, sidebar);

  const actions: Array<{ name: string; args: Record<string, string> }> = [];
  const get = vi.fn(async (name: string) => {
    if (name === '/api/config/console-themes')
      return { themes: { active: themeId === 'v2' ? 'pkg:v2' : 'sys:1', customs: [] } };
    if (name === '/api/console-themes/packages') return { packages: await builtinThemes.list() };
    if (name.startsWith('/api/console-themes/packages/'))
      return builtinThemes.read(name.slice('/api/console-themes/packages/'.length));
    if (name === '/api/config/chat-background') return { threads: {} };
    if (name === '/api/config/chat-background/images') return { images: [] };
    if (name === '/api/plugin-manager/plugins') return { plugins: [] };
    if (name === '/api/plugin-manager/pdl') return { fragments: {} };
    if (name.startsWith('/api/client-accounts') || name === '/api/accounts')
      return { providers: [], accounts: [], selection: { members: [] } };
    return {};
  });

  const port = {
    get threadId() {
      return data.threadId;
    },
    exportReady: Promise.resolve(),
    state: ui,
    needed: vi.fn(),
    get sidebarData() {
      return sidebar;
    },
    get data() {
      return fixtureInput(data);
    },
    get,
    post: vi.fn(async () => ({})),
    file: (p: string) => `/api/file/${p}`,
    attach: vi.fn(),
    action: vi.fn(async (name: string, args: Record<string, string>) => {
      actions.push({ name, args });
      if (name === 'homeTitle') ui.homeTitle = args.v ?? '';
      if (name === 'homePin') ui.homePin = args.pinned === 'true';
      return {};
    }),
    richRender: vi.fn(),
    terminal: vi.fn(),
    navResize: { min: 200, max: () => 400, width: () => 260, preview: vi.fn(), commit: vi.fn(), reset: vi.fn() },
  } as unknown as ChatPort;

  await w.clowderChat.start(port, chatModels);
  return { dom, w, evalIn, data, sidebar, actions };
}

describe('#2067 follow-up fixes across default and v2 themes', () => {
  for (const themeId of ['default', 'v2'] as const) {
    it(`preserves new-conversation title input and pin toggle feedback (${themeId})`, async () => {
      const { w, evalIn, actions } = await bootConsole(themeId, { threadId: 'default' });
      evalIn(`S.route='home';render(false);`);

      const titleInput = w.document.querySelector('[data-input="cafeHomeTitle"]') as HTMLInputElement | null;
      expect(titleInput).not.toBeNull();
      titleInput!.value = '自定义新对话标题';
      titleInput!.dispatchEvent(new w.Event('input', { bubbles: true }));
      expect(actions.some((a) => a.name === 'homeTitle' && a.args.v === '自定义新对话标题')).toBe(true);

      const pinControl = w.document.querySelector('[data-path="cs.homePin"]') as HTMLElement | null;
      expect(pinControl).not.toBeNull();
      pinControl!.click();
      expect(actions.some((a) => a.name === 'homePin' && a.args.pinned === 'true')).toBe(true);

      const pinAfter = w.document.querySelector('[data-path="cs.homePin"]') as HTMLInputElement | HTMLElement | null;
      expect(pinAfter).not.toBeNull();
      if (pinAfter!.tagName === 'INPUT') {
        expect((pinAfter as HTMLInputElement).checked).toBe(true);
      } else {
        expect(pinAfter!.getAttribute('aria-checked')).toBe('true');
      }
    });

    it(`shows zero-unread sidebar states (error, replied, mention, active member+elapsed) (${themeId})`, async () => {
      const now = Date.now();
      const { w } = await bootConsole(themeId, {
        configure: (data, sidebar) => {
          const base = data.threads[0];
          data.threads.push(
            { ...base, id: 't-err', title: '出错对话', lastActiveAt: now - 10_000 },
            { ...base, id: 't-done', title: '已回复对话', lastActiveAt: now - 20_000 },
            { ...base, id: 't-at', title: '被艾特对话', lastActiveAt: now - 30_000 },
            { ...base, id: 't-run', title: '活跃执行对话', lastActiveAt: now - 40_000 },
          );
          sidebar.threads = data.threads;
          sidebar.attention = [
            { id: 't-err', unreadCount: 0, hasUserMention: false, presence: { status: 'error' }, lastWho: '' },
            { id: 't-done', unreadCount: 0, hasUserMention: false, presence: { status: 'done' }, lastWho: '' },
            { id: 't-at', unreadCount: 0, hasUserMention: true, presence: { status: 'idle' }, lastWho: '' },
            {
              id: 't-run',
              unreadCount: 0,
              hasUserMention: false,
              presence: { status: 'working', cats: ['momo'], activeSince: now - 125_000 },
              lastWho: '',
            },
          ];
        },
      });

      const errRow = w.document.querySelector('[data-tid="t-err"]');
      const doneRow = w.document.querySelector('[data-tid="t-done"]');
      const atRow = w.document.querySelector('[data-tid="t-at"]');
      const runRow = w.document.querySelector('[data-tid="t-run"]');

      expect(errRow?.textContent).toContain('出错');
      expect(doneRow?.textContent).toContain('已回复');
      expect(atRow?.textContent).toContain('@');
      expect(runRow?.textContent).toContain('墨墨');
      expect(runRow?.textContent).toMatch(/2\s*分/);
    });

    it(`applies collapsed group attention cap (max 3, excludes mere running, shows attention count & overflow) (${themeId})`, async () => {
      const now = Date.now();
      const ids: string[] = [];
      const { w } = await bootConsole(themeId, {
        configure: (data, sidebar) => {
          const base = data.threads[0];
          const extraThreads = [];
          const attention: typeof sidebar.attention = [];
          for (let i = 1; i <= 11; i += 1) {
            const id = `g-thread-${i}`;
            ids.push(id);
            extraThreads.push({ ...base, id, title: `组会话 ${i}`, lastActiveAt: now - i * 1000 });
            if (i <= 2) {
              // Merely running, unread=0, at=false -> MUST NOT appear in collapsed peek
              attention.push({
                id,
                unreadCount: 0,
                hasUserMention: false,
                presence: { status: 'working', cats: ['momo'], activeSince: now - 60_000 },
                lastWho: '',
              });
            } else if (i === 3) {
              // @ mention -> highest priority among at/unread
              attention.push({
                id,
                unreadCount: 0,
                hasUserMention: true,
                presence: { status: 'idle' },
                lastWho: '',
              });
            } else if (i <= 7) {
              // 4 unread threads -> total 5 attention threads (3 peek + 2 overflow)
              attention.push({
                id,
                unreadCount: 2,
                hasUserMention: false,
                presence: { status: 'done' },
                lastWho: '',
              });
            } else {
              attention.push({
                id,
                unreadCount: 0,
                hasUserMention: false,
                presence: { status: 'idle' },
                lastWho: '',
              });
            }
          }
          data.threads.push(...extraThreads);
          sidebar.threads = data.threads;
          sidebar.attention = attention;
          sidebar.owner = {
            preferences: {
              groups: [{ id: 'grp-11', name: '11条测试组', threadIds: ids }],
              aliases: {},
              open: { 'group:grp-11': false },
              collapsedPeek: { 'group:grp-11': true },
              memberSort: {},
            },
            labels: [],
          };
        },
      });

      const sec = w.document.querySelector('[data-sec="grp:grp-11"], [data-section="grp:grp-11"]');
      expect(sec).not.toBeNull();
      expect(sec!.textContent).toContain('11');
      expect(sec!.textContent).toContain('5 条要看');
      expect(sec!.textContent).toContain('还有 2 条');

      const peekContainer = sec!.querySelector('.gsec-peek') ?? sec!;
      const visiblePeekRows = Array.from(peekContainer.querySelectorAll('[data-tid]') as NodeListOf<Element>).map(
        (el) => el.getAttribute('data-tid'),
      );
      expect(visiblePeekRows).toHaveLength(3);
      expect(visiblePeekRows[0]).toBe('g-thread-3');
      expect(visiblePeekRows).not.toContain('g-thread-1');
      expect(visiblePeekRows).not.toContain('g-thread-2');

      if (themeId === 'v2') {
        const groupBtn = sec!.querySelector('button[aria-expanded]');
        expect(groupBtn?.getAttribute('aria-expanded')).toBe('false');
        const menuBtn = sec!.querySelector('button[data-act="menu"]');
        expect(menuBtn).not.toBeNull();
        const titleBtn = sec!.querySelector('[data-tid="g-thread-3"] button[data-act="thread"]');
        expect(titleBtn).not.toBeNull();
      }
    });
  }

  it('shows runner elapsed times, stop buttons, and queue items in v2 composer, plus narrow-screen drawer control', async () => {
    const now = Date.now();
    const { w, actions } = await bootConsole('v2', {
      configure: (data) => {
        data.executions = [
          {
            executionId: 'exec-1',
            turnInvocationId: 'inv-1',
            threadId: data.threadId,
            catId: 'codex',
            startedAt: now - 125_000,
            activity: '写代码中',
            cancelability: { state: 'cancelable' },
          },
          {
            executionId: 'exec-2',
            turnInvocationId: 'inv-2',
            threadId: data.threadId,
            catId: 'momo',
            startedAt: now - 45_000,
            activity: '查日志',
            cancelability: { state: 'cancelable' },
          },
        ] as unknown as typeof data.executions;
        data.queue = [
          {
            id: 'q-1',
            messageId: 'm-q-1',
            content: '等跑完再帮我看下这一条',
            targetCats: ['codex'],
            status: 'queued',
          },
        ] as typeof data.queue;
      },
    });

    const runners = w.document.querySelector('[data-testid="composer-runners"]');
    expect(runners).not.toBeNull();
    expect(runners!.textContent).toContain('墨墨');
    expect(runners!.textContent).toMatch(/2:[0-5]\d/);
    expect(runners!.textContent).toMatch(/0:[45]\d|1:0\d/);

    const queueBox = w.document.querySelector('.qwrap');
    expect(queueBox).not.toBeNull();
    expect(queueBox!.textContent).toContain('排队中');
    expect(queueBox!.textContent).toContain('等跑完再帮我看下这一条');

    const stopBtn = runners!.querySelector('button[data-act="cafeRunStop"]') as HTMLButtonElement | null;
    expect(stopBtn).not.toBeNull();
    stopBtn!.click();
    await Promise.resolve();
    expect(actions.some((a) => a.name === 'cafeRunStop')).toBe(true);

    const drawerBtn = w.document.querySelector('[data-v2-nav-drawer="1"]');
    expect(drawerBtn).not.toBeNull();
  });
});
