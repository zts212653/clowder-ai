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
import { fixtureWorkbenchSource } from './owner-console';

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');

async function bootConsole(
  themeId: 'default' | 'v2',
  options: {
    threadId?: string;
    configure?: (data: ReturnType<typeof fixtureData>, sidebar: ReturnType<typeof fixtureSidebar>) => void;
    decisions?: (query?: Record<string, unknown>) => unknown[];
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
  const get = vi.fn(async (name: string, query?: Record<string, unknown>) => {
    if (name === '/api/config/console-themes')
      return { themes: { active: themeId === 'v2' ? 'pkg:v2' : 'sys:1', customs: [] } };
    if (name === '/api/console-themes/packages') return { packages: await builtinThemes.list() };
    if (name.startsWith('/api/console-themes/packages/'))
      return builtinThemes.read(name.slice('/api/console-themes/packages/'.length));
    if (name === '/api/config/chat-background') return { threads: {} };
    if (name === '/api/config/chat-background/images') return { images: [] };
    if (name === '/api/plugin-manager/plugins') return { plugins: [] };
    if (name === '/api/plugin-manager/pdl') return { fragments: {} };
    if (name === '/api/concierge/work/decisions') {
      const all = query?.mentionPeriod === 'handled' ? [] : (options.decisions?.(query) ?? []);
      const offset = Number(query?.offset ?? 0);
      const limit = Number(query?.limit ?? 20);
      const items = all.slice(offset, offset + limit);
      return {
        status: 'available',
        observedAt: Date.now(),
        identity: { ownerUserId: 'owner' },
        attentionCount: all.length,
        page: { offset, limit, hasMore: offset + items.length < all.length },
        items,
      };
    }
    if (name === '/api/concierge/confirmations') return { confirmations: [] };
    if (name === '/api/concierge/thread') return { threadId: null };
    if (name === '/api/concierge/work/mentions/last-handling') return { receipt: null };
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
    it(`dispatches each attachment close button to its Host file index (${themeId})`, async () => {
      const { dom, w, actions } = await bootConsole(themeId, {
        configure: (data) => {
          data.images = [
            new File(['first'], 'first.png', { type: 'image/png' }),
            new File(['second'], 'second.png', { type: 'image/png' }),
          ];
        },
      });
      try {
        const document: Document = w.document;
        const previews = [...document.querySelectorAll('[data-act="draftAttachment"]')];
        expect(previews).toHaveLength(2);
        const closeButtons = previews.map(
          (preview) => preview.parentElement!.querySelector<HTMLButtonElement>('button:last-child')!,
        );
        for (const close of closeButtons) {
          expect(close.dataset.act).not.toBe('draftAttachment');
          close.click();
        }
        await w.__settled();
        expect(actions.filter(({ name }) => name === 'removeImage').map(({ args }) => Number(args.id))).toEqual([0, 1]);
      } finally {
        await w.__settled();
        dom.window.close();
      }
    });

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
            { ...base, id: 't-finalize', title: '正在收尾的对话', lastActiveAt: now - 50_000 },
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
            {
              id: 't-finalize',
              unreadCount: 0,
              hasUserMention: false,
              presence: { status: 'working', cats: ['momo'], activeSince: now - 125_000 },
              lastWho: '',
            },
          ];
          data.executions = [
            {
              executionId: 'settling-run',
              turnInvocationId: 'settling-turn',
              threadId: 't-finalize',
              threadTitle: '正在收尾的对话',
              catId: 'momo',
              kind: 'live_invocation',
              phase: 'finalizing',
              startedAt: now - 125_000,
              cancelability: { state: 'not_cancelable', reason: 'terminalizing' },
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
      const finalizingRow = w.document.querySelector('[data-tid="t-finalize"]');
      expect(finalizingRow?.textContent).toContain('墨墨 正在收尾');
      expect(finalizingRow?.textContent).not.toContain('执行中');
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

    it(`counts and prioritizes a pending-only (zero-unread) thread in collapsed groups (${themeId})`, async () => {
      const now = Date.now();
      let activeDecisions: unknown[] = [
        themeId === 'default'
          ? {
              decisionRef: 'f306.runtime_interaction:int-1',
              kind: 'approval',
              summary: '请确认发布方案',
              runtimeInteraction: {
                interactionId: 'int-1',
                revision: 1,
                requesterCatId: 'momo',
                createdAt: now - 5_000,
                title: '请确认发布方案',
                kind: 'conversation_decision',
                cardRef: { threadId: 'g-pending', messageId: 'm-dec-1', blockId: 'b-1' },
              },
              linkedNeedsMe: [],
            }
          : {
              decisionRef: 'f246.approval:prop-1',
              kind: 'approval',
              summary: '请审批新线程提案',
              approval: {
                proposalId: 'prop-1',
                sourceFeatureId: 'F128',
                requesterCatId: 'momo',
                summary: '请审批新线程提案',
                detail: {},
                inlineApprovable: true,
                resolution: 'open',
                materialization: { state: 'not_started' },
                createdAt: now - 5_000,
                navigation: {
                  state: 'anchored',
                  originRef: { kind: 'message', threadId: 'g-pending', messageId: 'm-dec-2' },
                  approvalCardRef: { threadId: 'g-pending', messageId: 'm-dec-2' },
                },
              },
              linkedNeedsMe: [],
            },
      ];
      const { w, evalIn } = await bootConsole(themeId, {
        decisions: () => activeDecisions,
        configure: (data, sidebar) => {
          const ids = [
            'g-pending',
            'g-at',
            'g-unread-1',
            'g-unread-2',
            'g-quiet-1',
            'g-quiet-2',
            'g-quiet-3',
            'g-quiet-4',
            'g-quiet-5',
            'g-quiet-6',
            'g-quiet-7',
          ];
          const extra = ids.map((id, i) => ({
            ...data.threads[0],
            id,
            title: `分组会话 ${id}`,
            pinned: false,
            lastActiveAt: now - i * 60_000,
          }));
          data.threads.push(...extra);
          sidebar.threads = [...data.threads];
          sidebar.attention.push(
            { id: 'g-pending', unreadCount: 0, hasUserMention: false, presence: { status: 'idle' }, lastWho: '' },
            { id: 'g-at', unreadCount: 0, hasUserMention: true, presence: { status: 'idle' }, lastWho: '' },
            { id: 'g-unread-1', unreadCount: 2, hasUserMention: false, presence: { status: 'idle' }, lastWho: '' },
            { id: 'g-unread-2', unreadCount: 1, hasUserMention: false, presence: { status: 'idle' }, lastWho: '' },
            ...ids.slice(4).map((id) => ({
              id,
              unreadCount: 0,
              hasUserMention: false,
              presence: { status: 'idle' as const },
              lastWho: '',
            })),
          );
          sidebar.owner = {
            preferences: {
              groups: [{ id: 'grp-pending', name: '待决定组', threadIds: ids }],
              open: { 'group:grp-pending': false },
              collapsedPeek: { 'group:grp-pending': true },
              memberSort: {},
            },
            labels: [],
          };
        },
      });

      // Wait for boot inbox load + rerender to settle.
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10));

      const sec = w.document.querySelector('[data-sec="grp:grp-pending"], [data-section="grp:grp-pending"]');
      expect(sec).not.toBeNull();
      expect(sec!.textContent).toContain('11');
      expect(sec!.textContent).toContain('4 条要看');
      expect(sec!.textContent).toContain('还有 1 条');

      const peekContainer = sec!.querySelector('.gsec-peek') ?? sec!;
      const visiblePeekRows = Array.from(peekContainer.querySelectorAll('[data-tid]') as NodeListOf<Element>).map(
        (el) => el.getAttribute('data-tid'),
      );
      expect(visiblePeekRows).toEqual(['g-pending', 'g-at', 'g-unread-1']);
      const pendingRowEl = peekContainer.querySelector('[data-tid="g-pending"]');
      expect(pendingRowEl?.textContent).toContain('等你决定');

      const navModel = evalIn('VM.navThreads()') as {
        sections: Array<{ key: string; rows: Array<{ id: string; pending: number; unread: number }> }>;
      };
      const pendingRow = navModel.sections
        .find((s) => s.key === 'grp:grp-pending')
        ?.rows.find((r) => r.id === 'g-pending');
      expect(pendingRow?.pending).toBe(1);
      expect(pendingRow?.unread).toBe(0);

      // Once the pending decision is resolved, inbox reload updates the collapsed group count and preview.
      activeDecisions = [];
      await w.clowderChat.emit('cat-cafe:runtime-interaction-updated');
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 10));

      const updatedSec = w.document.querySelector('[data-sec="grp:grp-pending"], [data-section="grp:grp-pending"]');
      expect(updatedSec!.textContent).toContain('3 条要看');
      expect(updatedSec!.textContent).not.toContain('还有 1 条');
      const updatedPeek = Array.from(
        (updatedSec!.querySelector('.gsec-peek') ?? updatedSec!).querySelectorAll('[data-tid]') as NodeListOf<Element>,
      ).map((el) => el.getAttribute('data-tid'));
      expect(updatedPeek).toEqual(['g-at', 'g-unread-1', 'g-unread-2']);
    });

    it(`loads pending decisions from page 2+ without opening inbox and shows 等你决定 cue (${themeId})`, async () => {
      const now = Date.now();
      const fillerDecisions = Array.from({ length: 20 }, (_, i) => ({
        decisionRef: `f306.runtime_interaction:other-${i}`,
        kind: 'approval',
        summary: `其他会话待决定 ${i}`,
        runtimeInteraction: {
          interactionId: `other-${i}`,
          revision: 1,
          requesterCatId: 'momo',
          createdAt: now - (i + 1) * 1_000,
          title: `其他会话待决定 ${i}`,
          kind: 'conversation_decision',
          cardRef: { threadId: `other-thread-${i}`, messageId: `m-other-${i}`, blockId: `b-${i}` },
        },
        linkedNeedsMe: [],
      }));
      const groupDecision = {
        decisionRef: 'f306.runtime_interaction:page2-group',
        kind: 'approval',
        summary: '第二页分组待决定',
        runtimeInteraction: {
          interactionId: 'page2-group',
          revision: 1,
          requesterCatId: 'momo',
          createdAt: now - 30_000,
          title: '第二页分组待决定',
          kind: 'conversation_decision',
          cardRef: { threadId: 'g-pending', messageId: 'm-page2', blockId: 'b-page2' },
        },
        linkedNeedsMe: [],
      };
      let failPage2Once = false;
      let page2Failures = 0;
      let includeGroupDecision = true;
      const { w } = await bootConsole(themeId, {
        decisions: (query) => {
          if (failPage2Once && Number(query?.offset ?? 0) >= 20) {
            failPage2Once = false;
            page2Failures += 1;
            throw new Error('HTTP 503 Service Unavailable');
          }
          return includeGroupDecision ? [...fillerDecisions, groupDecision] : [...fillerDecisions];
        },
        configure: (data, sidebar) => {
          const ids = [
            'g-pending',
            'g-at',
            'g-unread-1',
            'g-unread-2',
            'g-quiet-1',
            'g-quiet-2',
            'g-quiet-3',
            'g-quiet-4',
            'g-quiet-5',
            'g-quiet-6',
            'g-quiet-7',
          ];
          data.threads.push(
            ...ids.map((id, i) => ({
              ...data.threads[0],
              id,
              title: `分页会话 ${id}`,
              pinned: false,
              lastActiveAt: now - i * 60_000,
            })),
          );
          sidebar.threads = [...data.threads];
          sidebar.attention.push(
            { id: 'g-pending', unreadCount: 0, hasUserMention: false, presence: { status: 'idle' }, lastWho: '' },
            { id: 'g-at', unreadCount: 0, hasUserMention: true, presence: { status: 'idle' }, lastWho: '' },
            { id: 'g-unread-1', unreadCount: 2, hasUserMention: false, presence: { status: 'idle' }, lastWho: '' },
            { id: 'g-unread-2', unreadCount: 1, hasUserMention: false, presence: { status: 'idle' }, lastWho: '' },
            ...ids.slice(4).map((id) => ({
              id,
              unreadCount: 0,
              hasUserMention: false,
              presence: { status: 'idle' as const },
              lastWho: '',
            })),
          );
          sidebar.owner = {
            preferences: {
              groups: [{ id: 'grp-page2', name: '跨页待决定组', threadIds: ids }],
              open: { 'group:grp-page2': false },
              collapsedPeek: { 'group:grp-page2': true },
              memberSort: {},
            },
            labels: [],
          };
        },
      });

      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10));

      const assertGroupDecisionVisible = () => {
        const sec = w.document.querySelector('[data-sec="grp:grp-page2"], [data-section="grp:grp-page2"]');
        expect(sec).not.toBeNull();
        expect(sec!.textContent).toContain('4 条要看');
        expect(sec!.textContent).toContain('还有 1 条');

        const peekContainer = sec!.querySelector('.gsec-peek') ?? sec!;
        const visiblePeekRows = Array.from(peekContainer.querySelectorAll('[data-tid]') as NodeListOf<Element>).map(
          (el) => el.getAttribute('data-tid'),
        );
        expect(visiblePeekRows).toEqual(['g-pending', 'g-at', 'g-unread-1']);

        const pendingRowEl = peekContainer.querySelector('[data-tid="g-pending"]');
        expect(pendingRowEl?.textContent).toContain('等你决定');
        if (themeId === 'v2') {
          expect(pendingRowEl?.innerHTML).toContain('var(--semantic-warning)');
          expect(pendingRowEl?.querySelector('button[data-act="thread"]')?.className).toContain('font-semibold');
        } else {
          expect(pendingRowEl?.querySelector('.dot[data-tone="warn"]')).not.toBeNull();
        }
      };

      // 1. Initial complete paginated load shows all 4 items including page-2 pending decision
      assertGroupDecisionVisible();

      // 2. Transient 503 on page 2 during refresh must retain the previous complete decision list
      failPage2Once = true;
      w.clowderChat.emit('cat-cafe:runtime-interaction-updated', undefined);
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10));
      expect(page2Failures).toBe(1);
      assertGroupDecisionVisible();

      // 3. Subsequent refresh succeeds and stays consistent
      w.clowderChat.emit('cat-cafe:runtime-interaction-updated', undefined);
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10));
      assertGroupDecisionVisible();

      // 4. Once the decision is genuinely resolved on a complete refresh, counts update cleanly
      includeGroupDecision = false;
      w.clowderChat.emit('cat-cafe:runtime-interaction-updated', undefined);
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 10));
      const secAfterResolve = w.document.querySelector('[data-sec="grp:grp-page2"], [data-section="grp:grp-page2"]');
      expect(secAfterResolve!.textContent).toContain('3 条要看');
      const peekAfterResolve = secAfterResolve!.querySelector('.gsec-peek') ?? secAfterResolve!;
      expect(peekAfterResolve.querySelector('[data-tid="g-pending"]')).toBeNull();
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

  for (const themeId of ['default', 'v2'] as const) {
    it(`preserves #2031 documentFrame wiring and marks tall PDF/PPTX frames in workbench (${themeId})`, async () => {
      const { w, evalIn } = await bootConsole(themeId);
      const benchBase = {
        ...fixtureWorkbenchSource(),
        workspace: {
          worktreeId: 'wt',
          worktrees: [{ id: 'wt', root: '/project', branch: 'next', head: '266714d', current: true }],
          tree: [
            { path: 'deck.pptx', kind: 'file' },
            { path: 'report.pdf', kind: 'file' },
            { path: 'spec.docx', kind: 'file' },
          ],
          loading: false,
          error: null,
        },
        opened: null,
      };
      const pushOpened = (name: string, mime: string, pageUnit: string, pageCount: number) => {
        w.clowderChat.pushProject({
          workbench: {
            ...benchBase,
            opened: {
              worktreeId: 'wt',
              file: {
                path: name,
                absolutePath: `/project/${name}`,
                binary: true,
                mime,
                content: '',
                sha256: `sha-${name}`,
                size: 24_576,
                modifiedAt: 1_795_400_000_000,
                pageUnit,
                pageCount,
              },
            },
          },
        });
      };

      w.clowderChat.pushProject({ workbench: benchBase });

      // 1. Open PPTX from 项目文件 -> mounts tall documentFrame iframe
      await evalIn(`A.wsFile({ p: 'deck.pptx', w: 'wt' })`);
      pushOpened('deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'slides', 1);
      evalIn(`render(true)`);
      const pptxFrame = w.document.querySelector('aside.panel iframe') as HTMLIFrameElement | null;
      expect(pptxFrame).not.toBeNull();
      expect(pptxFrame?.getAttribute('src')).toBe('/workspace-document?worktreeId=wt&path=deck.pptx');
      expect(pptxFrame?.classList.contains('tall')).toBe(true);
      expect(pptxFrame?.classList.contains(themeId === 'v2' ? 'v2-frame' : 'vw-widget')).toBe(true);
      if (themeId === 'v2') {
        expect(pptxFrame?.classList.contains('h-full')).toBe(false);
        expect(w.document.querySelector('aside.panel [data-view="file.body"]')).not.toBeNull();
      }

      // 2. Open PDF from 项目文件 -> mounts tall documentFrame iframe
      await evalIn(`A.wsFile({ p: 'report.pdf', w: 'wt' })`);
      pushOpened('report.pdf', 'application/pdf', 'pages', 1);
      evalIn(`render(true)`);
      const pdfFrame = w.document.querySelector('aside.panel iframe') as HTMLIFrameElement | null;
      expect(pdfFrame).not.toBeNull();
      expect(pdfFrame?.getAttribute('src')).toBe('/workspace-document?worktreeId=wt&path=report.pdf');
      expect(pdfFrame?.classList.contains('tall')).toBe(true);
      if (themeId === 'v2') {
        expect(pdfFrame?.classList.contains('h-full')).toBe(false);
      }

      // 3. Open DOCX -> stays behind explicit fileOffice trigger until clicked
      await evalIn(`A.wsFile({ p: 'spec.docx', w: 'wt' })`);
      pushOpened('spec.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'pages', 1);
      evalIn(`render(true)`);
      expect(w.document.querySelector('aside.panel iframe')).toBeNull();
      const editBtn = w.document.querySelector('aside.panel [data-act="fileOffice"]') as HTMLButtonElement | null;
      expect(editBtn).not.toBeNull();
      expect(editBtn?.textContent?.trim()).toBe('协作编辑');
      editBtn!.click();
      evalIn(`render(true)`);
      const docxFrame = w.document.querySelector('aside.panel iframe') as HTMLIFrameElement | null;
      expect(docxFrame?.getAttribute('src')).toBe('/workspace-document?worktreeId=wt&path=spec.docx');
      expect(docxFrame?.classList.contains('tall')).toBe(true);
    });
  }

  it('gives v2 tall document frames default-parity viewport height without container-specific overrides', () => {
    const v2Css = readFileSync(path.join(process.cwd(), 'public/pdl/themes/v2/components/v2/v2.css'), 'utf8');
    const v2bCss = readFileSync(path.join(process.cwd(), 'public/pdl/themes/v2/components/v2/v2b.css'), 'utf8');
    expect(v2Css).toContain(
      '.v2-shell .v2-workbench > .panel-body:has(.home-v2, .v2-works-panel) { padding:0; gap:0; overflow:hidden; }',
    );
    expect(v2bCss).toContain('.v2-frame.tall { min-height:calc(var(--row-h) * 12); }');
    expect(v2bCss).toContain(
      '.v2-frame[src].tall { min-height:round(down, 100vh - 5 * var(--row-h-1), var(--row-h-1)); }',
    );
    expect(v2bCss).toContain('.v2-starry-page > .v2-frame { height:100%; min-height:0; }');
    expect(v2bCss).not.toContain('.space-y-4');
    expect(v2bCss).not.toContain('.split.wide .panel-body > :has(.v2-frame[src].tall)');
  });
});
