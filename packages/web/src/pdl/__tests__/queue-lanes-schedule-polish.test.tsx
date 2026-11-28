import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  coordinate,
  scheduleBlock,
  scheduleItem,
  scheduleProposal,
} from '@/components/rich/__tests__/schedule-approval.fixture';
import { scheduleApprovalCopy } from '@/components/rich/schedule-approval.shell-copy';
import { useScheduleApprovalController } from '@/components/rich/useScheduleApprovalController';
import { approvalResultRead } from '@/lib/approval-result-read';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { QueueEntry } from '@/stores/chat-types';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { chatModels } from '../chat-models';
import { scriptSources } from '../runtime';
import { fixtureData, fixtureUi } from './chat-fixture';
import { act, cleanup, renderHook } from './hook-host';

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom');

async function bootPdlEngine() {
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

describe('PDL lanes, queue drag/recall, and schedule approval regressions', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    approvalResultRead.clear();
  });

  it('constrains share-based lanes with minmax(0, Nfr) in both default and v2 themes', async () => {
    const { dom, evaluate } = await bootPdlEngine();
    try {
      const lanesExpr = `PDL_BLOCKS.lanes({
        lanes: [
          { share: 2, name: 'run', attach: 'straddle', items: [] },
          { share: 3, name: 'notice', align: 'center', items: [{ type: 'text', text: 'A very long notice title' }] },
          { share: 2, name: 'queue', align: 'end', attach: 'straddle', items: [{ type: 'text', text: 'Queued' }] },
        ],
      }, {}, {})`;
      const defaultHtml = evaluate(lanesExpr) as string;
      expect(defaultHtml).toContain('--lanes:minmax(0, 2fr) minmax(0, 3fr) minmax(0, 2fr)');
      expect(defaultHtml).not.toContain('max-content');

      // Load v2 component override and assert the same constraint on v2's PDL_BLOCKS.lanes
      for (const file of ['v2.js', 'v2b.js', 'v2c.js']) {
        evaluate(readFileSync(path.join('public/pdl/themes/v2/components/v2', file), 'utf8'));
      }
      const v2Html = evaluate(`PDL_BLOCKS.lanes({
        lanes: [
          { share: 2, name: 'run', attach: 'straddle', items: [] },
          { share: 3, name: 'notice', align: 'center', items: [{ use: 'v2Notice', props: { text: { lit: 'A very long v2 notice title' } } }] },
          { share: 2, name: 'queue', align: 'end', attach: 'straddle', items: [{ use: 'v2Action', props: { label: { lit: 'Queued' } } }] },
        ],
      }, {}, {})`) as string;
      expect(v2Html).toContain('--lanes:minmax(0, 2fr) minmax(0, 3fr) minmax(0, 2fr)');
      expect(v2Html).not.toContain('max-content');

      // v2ThreadRow renders the pin glyph on BOTH pinned (visible) and unpinned (hover-revealed) rows
      const v2RowExpr = (pinned: boolean) => `PDL_COMPONENTS.v2ThreadRow({
        data: { lit: { id: 't1', title: 'Test thread', pinned: ${pinned}, time: 'now', cur: false } },
        open: { act: 'thread', args: { id: 't1' } },
        pin: { act: 'setStatus', args: { entity: 'pin', id: 't1' }, label: '${pinned ? 'Unpin' : 'Pin'}' },
        more: [],
        signals: [],
      }, {}, {})`;
      const unpinnedHtml = evaluate(v2RowExpr(false)) as string;
      expect(unpinnedHtml).toContain('opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100');
      expect(unpinnedHtml).toContain('data-act="setStatus"');
      expect(unpinnedHtml).toContain('<svg');
      const pinnedHtml = evaluate(v2RowExpr(true)) as string;
      expect(pinnedHtml).not.toContain('opacity-0');
      expect(pinnedHtml).toContain('var(--shell-primary)');
      expect(pinnedHtml).toContain('<svg');
    } finally {
      dom.window.close();
    }
  });

  it('protects native buttons and [data-act] controls inside orderable rows (including v2 member rows) while preserving drag surfaces and iframe cleanup', async () => {
    const { dom, w, evaluate } = await bootPdlEngine();
    try {
      const app = w.document.getElementById('app')!;
      app.innerHTML =
        '<iframe id="plugin-frame"></iframe>' +
        '<div class="group lr-list" data-ocontainer="list:queue:t1" data-order-act="cafeQueueOrder">' +
        '<div class="lr qitem" data-okey="q1" data-edit="order">' +
        '<div class="lr-head">' +
        '<span class="lr-main"><span class="lr-title">Queued item</span></span>' +
        '<span class="lr-end"><span class="lr-acts">' +
        '<button type="button" class="btn btn-sm btn-icon" data-act="cafeQueue" data-v="edit" data-i="0">edit</button>' +
        '</span></span>' +
        '</div></div></div>' +
        '<table><tbody data-ocontainer="list:um-members" data-order-act="umOrder">' +
        '<tr data-cat-id="c1" data-okey="c1" data-edit="order">' +
        '<td><span class="member-sort">⠿</span></td>' +
        '<td><button type="button" class="member-name" data-act="open" data-page="member" data-p="c1"><span><strong>Cat</strong></span></button></td>' +
        '<td><button type="button" class="member-aliases">@cat</button></td>' +
        '<td><button type="button" class="member-switch" role="switch" aria-checked="true" data-act="setStatus" data-entity="member" data-id="c1"><span></span></button></td>' +
        '<td><span class="custom-act" data-act="customPing">ping</span></td>' +
        '</tr></tbody></table>' +
        '<div class="ws-strip" data-ocontainer="tabs.panel" data-order-act="tab" data-op="order" data-r="panel">' +
        '<span class="ws-chip" data-okey="t1" data-edit="order">' +
        '<button type="button" class="ws-chip-t" data-drag-surface data-act="tab" data-op="show" data-r="panel" data-k="t1">Tab 1</button>' +
        '<button type="button" class="btn btn-xs btn-icon" data-act="tab" data-op="close" data-r="panel" data-k="t1">x</button>' +
        '</span></div>' +
        '<div id="orphan-ct" data-edit="ct">orphan</div>';

      evaluate(
        'window.__clicks = []; A.cafeQueue = function (d) { window.__clicks.push(["queue", d]); }; A.open = function (d) { window.__clicks.push(["open", d]); }; A.setStatus = function (d) { window.__clicks.push(["status", d]); }; A.customPing = function (d) { window.__clicks.push(["ping", d]); };',
      );

      const frame = app.querySelector('#plugin-frame') as HTMLIFrameElement;
      const btn = app.querySelector('button[data-act="cafeQueue"]') as HTMLButtonElement;
      const row = app.querySelector('.lr.qitem') as HTMLElement;

      // 1. Action button (.btn) inside orderable queue row with 20px movement never drags or eats click
      btn.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 20 }));
      expect(row.style.cursor).toBe('');
      btn.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 20 }));
      btn.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: 120, clientY: 20 }));
      btn.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 120, clientY: 20 }));
      btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 120, clientY: 20 }));
      expect(evaluate('window.__clicks.length')).toBe(1);

      // 2. v2 member table non-.btn native <button>s and non-button [data-act] never drag or eat click
      const memberRow = app.querySelector('tr[data-cat-id="c1"]') as HTMLElement;
      let aliasesClicked = 0;
      const aliasesBtn = memberRow.querySelector('.member-aliases') as HTMLButtonElement;
      aliasesBtn.addEventListener('click', () => {
        aliasesClicked++;
      });
      for (const target of [
        memberRow.querySelector('.member-name strong') as HTMLElement,
        aliasesBtn,
        memberRow.querySelector('.member-switch') as HTMLElement,
        memberRow.querySelector('.custom-act') as HTMLElement,
      ]) {
        target.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 50, clientY: 50 }));
        target.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: 70, clientY: 50 }));
        expect(memberRow.classList.contains('edit-drag')).toBe(false);
        target.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 70, clientY: 50 }));
        target.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 70, clientY: 50 }));
      }
      expect(evaluate('window.__clicks.map(x => x[0])')).toEqual(['queue', 'open', 'status', 'ping']);
      expect(aliasesClicked).toBe(1);

      // Dragging the grip handle on the v2 member row still starts drag after 4px slop
      const grip = memberRow.querySelector('.member-sort') as HTMLElement;
      grip.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 50 }));
      grip.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: 25, clientY: 50 }));
      expect(memberRow.classList.contains('edit-drag')).toBe(true);
      grip.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 25, clientY: 50 }));
      grip.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 25, clientY: 50 }));
      expect(frame.style.pointerEvents).toBe('');

      // 3. Micro jitter (<4px) on the draggable row body itself must NOT start drag or eat clicks
      let bodyClicked = 0;
      row.addEventListener('click', () => {
        bodyClicked++;
      });
      const title = app.querySelector('.lr-title') as HTMLElement;
      title.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 40, clientY: 20 }));
      title.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: 42, clientY: 21 }));
      expect(row.classList.contains('edit-drag')).toBe(false);
      title.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 42, clientY: 21 }));
      title.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 42, clientY: 21 }));
      expect(bodyClicked).toBe(1);

      // 4. Primary drag surface (.ws-chip-t with data-drag-surface) remains draggable beyond 4px slop
      const tabChip = app.querySelector('.ws-chip') as HTMLElement;
      const tabBtn = app.querySelector('.ws-chip-t') as HTMLButtonElement;
      tabBtn.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 30, clientY: 10 }));
      tabBtn.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: 45, clientY: 10 }));
      expect(tabChip.classList.contains('edit-drag')).toBe(true);
      tabBtn.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 45, clientY: 10 }));
      expect(frame.style.pointerEvents).toBe('');

      // 5. Rejected delayed start() (e.g. data-edit="ct" outside data-ocontainer in editLayout) must restore iframe pointerEvents
      evaluate('S.editLayout = true;');
      const orphan = app.querySelector('#orphan-ct') as HTMLElement;
      orphan.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
      expect(frame.style.pointerEvents).toBe('none');
      orphan.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: 30, clientY: 10 }));
      expect(frame.style.pointerEvents).toBe('');
      orphan.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 30, clientY: 10 }));
      expect(frame.style.pointerEvents).toBe('');
    } finally {
      dom.window.close();
    }
  });

  it('marks only queued user entries as recallable (hiding recall-and-edit on queued agent A2A items)', () => {
    const data = fixtureData();
    data.queue = [
      {
        id: 'q-agent',
        threadId: data.threadId,
        messageId: 'msg-a2a',
        content: '@gemini A2A handoff',
        from: { kind: 'agent', catId: 'codex' },
        targetCats: ['cat-drby1x4c'],
        status: 'queued',
      } as QueueEntry,
      {
        id: 'q-user',
        threadId: data.threadId,
        messageId: 'msg-user',
        content: 'Owner follow-up',
        from: { kind: 'user', userId: 'default-user' },
        targetCats: ['cat-drby1x4c'],
        status: 'queued',
      } as QueueEntry,
    ];
    const items = chatModels(data, fixtureUi()).chatComposer.queue!.items;
    expect(items[0]).toMatchObject({ key: 'q-agent', queued: true, recallable: false });
    expect(items[1]).toMatchObject({ key: 'q-user', queued: true, recallable: true });
  });

  it('renders a preparing queue row without actions that require a queued source', async () => {
    const data = fixtureData();
    data.queue = [
      {
        id: 'q-preparing',
        threadId: data.threadId,
        userId: 'default-user',
        mergedMessageIds: [],
        intent: 'execute',
        createdAt: 0,
        messageId: 'msg-user',
        content: 'Owner follow-up',
        from: { kind: 'user', userId: 'default-user' },
        targetCats: [],
        status: 'processing',
      },
    ];
    const item = chatModels(data, fixtureUi()).chatComposer.queue?.items[0];
    expect(item).toMatchObject({ processing: true, queued: false, recallable: false, orderable: false });

    const { dom, w, evaluate } = await bootPdlEngine();
    try {
      const labels = readFileSync('public/pdl/themes/default/i18n/zh/library.json', 'utf8');
      evaluate('defineI18n("zh", ' + labels + ')');
      const props = {
        key: 'test',
        label: 'Queue',
        order: true,
        items: { lit: [item] },
        actions: [
          { act: 'cafeQueueSend', label: 'Send', when: '@queued' },
          { act: 'cafeQueue', label: 'Edit', when: '@recallable' },
        ],
      };
      w.document.body.innerHTML = evaluate('PDL_COMPONENTS.queue(' + JSON.stringify(props) + ', {}, {})');
      const row = w.document.querySelector('.qitem');
      expect(row?.textContent).toContain('准备发送');
      expect(row?.querySelector('[data-act="cafeQueueSend"], [data-act="cafeQueue"], .lr-grip')).toBeNull();
    } finally {
      dom.window.close();
    }
  });

  it('projects localized zh/en fields for create/delete schedule proposals without saying 原定时任务', () => {
    expect(scheduleApprovalCopy.zh.unavailable).not.toContain('原定时任务');
    expect(scheduleApprovalCopy.zh.checking).not.toContain('原定时任务');
    expect(scheduleApprovalCopy.zh.changed).not.toContain('原定时任务');
    expect(scheduleApprovalCopy.en.unavailable).toContain('proposal');

    const data = fixtureData();
    const proposal = scheduleProposal('pending');
    if (proposal.mutation.kind !== 'create') throw new Error('expected create fixture');
    proposal.mutation.task.trigger = { type: 'interval', ms: 1_200_000 };
    proposal.mutation.task.deliveryThreadId = data.threadId;
    proposal.mutation.task.params = { text: 'Inspect RSI items' };
    data.schedules = {
      schedule: {
        mid: 'reply-1',
        blockId: 'schedule-card',
        proposal,
        current: true,
        blocked: false,
        drifted: false,
        error: null,
        decide: vi.fn(),
      },
    };
    const zhCard = chatModels(data, { ...fixtureUi(), lang: 'zh' }).chatStream.items.find(
      (item) => item.mid === 'reply-1',
    )!.card as { fields?: Array<{ k: string; v: string }> };
    expect(zhCard.fields).toEqual([
      { k: scheduleApprovalCopy.zh.time, v: '每 20 分钟' },
      { k: scheduleApprovalCopy.zh.destination, v: data.threads[0].title },
      { k: scheduleApprovalCopy.zh.template, v: proposal.mutation.task.templateId },
      { k: scheduleApprovalCopy.zh.params, v: 'Inspect RSI items' },
    ]);

    const enCard = chatModels(data, { ...fixtureUi(), lang: 'en' }).chatStream.items.find(
      (item) => item.mid === 'reply-1',
    )!.card as { fields?: Array<{ k: string; v: string }> };
    expect(enCard.fields).toEqual([
      { k: scheduleApprovalCopy.en.time, v: 'Every 20 minutes' },
      { k: scheduleApprovalCopy.en.destination, v: data.threads[0].title },
      { k: scheduleApprovalCopy.en.template, v: proposal.mutation.task.templateId },
      { k: scheduleApprovalCopy.en.params, v: 'Inspect RSI items' },
    ]);
    for (const field of enCard.fields!) {
      expect(field.k).not.toMatch(/[\u4e00-\u9fff]/);
    }

    // Relative-once + no deliveryThreadId + explicit once locale + weekday cron in both zh and en
    const noDestProposal = scheduleProposal('pending');
    if (noDestProposal.mutation.kind !== 'create') throw new Error('expected create fixture');
    const fireAt = Date.parse('2026-11-22T18:30:00.000Z');
    noDestProposal.mutation.relativeOnceDelayMs = 600_000;
    noDestProposal.mutation.task.trigger = { type: 'once', fireAt };
    noDestProposal.mutation.task.deliveryThreadId = null;
    data.schedules.schedule.proposal = noDestProposal;

    const relZh = chatModels(data, { ...fixtureUi(), lang: 'zh' }).chatStream.items.find(
      (item) => item.mid === 'reply-1',
    )!.card as { fields?: Array<{ k: string; v: string }> };
    expect(relZh.fields![0]).toEqual({ k: '什么时候', v: '批准后 10 分钟执行一次' });
    expect(relZh.fields![1]).toEqual({ k: '送到哪条对话', v: '不向对话送消息' });

    const relEn = chatModels(data, { ...fixtureUi(), lang: 'en' }).chatStream.items.find(
      (item) => item.mid === 'reply-1',
    )!.card as { fields?: Array<{ k: string; v: string }> };
    expect(relEn.fields![0]).toEqual({ k: 'When', v: 'After approval: 10 minutes later, once' });
    expect(relEn.fields![1]).toEqual({ k: 'Destination conversation', v: 'No conversation delivery' });

    delete noDestProposal.mutation.relativeOnceDelayMs;
    const onceZh = chatModels(data, { ...fixtureUi(), lang: 'zh' }).chatStream.items.find(
      (item) => item.mid === 'reply-1',
    )!.card as { fields?: Array<{ k: string; v: string }> };
    expect(onceZh.fields![0].v).toBe(`执行一次：${new Date(fireAt).toLocaleString('zh-CN')}`);

    const onceEn = chatModels(data, { ...fixtureUi(), lang: 'en' }).chatStream.items.find(
      (item) => item.mid === 'reply-1',
    )!.card as { fields?: Array<{ k: string; v: string }> };
    expect(onceEn.fields![0].v).toBe(`Once at ${new Date(fireAt).toLocaleString('en-US')}`);
    expect(onceEn.fields![0].v).not.toMatch(/[\u4e00-\u9fff]/);

    // Weekday cron in zh has no stray space ("周一"), and VM ignores v2 shell-language localStorage
    noDestProposal.mutation.task.trigger = { type: 'cron', expression: '30 9 * * 1' };
    window.localStorage.setItem('cat-cafe:shell-language', 'en');
    try {
      const cronDefault = chatModels(data, fixtureUi()).chatStream.items.find((item) => item.mid === 'reply-1')!
        .card as { fields?: Array<{ k: string; v: string }> };
      expect(cronDefault.fields![0]).toEqual({ k: '什么时候', v: '周一 09:30 · 调度器的本地时区' });

      const cronEn = chatModels(data, { ...fixtureUi(), lang: 'en' }).chatStream.items.find(
        (item) => item.mid === 'reply-1',
      )!.card as { fields?: Array<{ k: string; v: string }> };
      expect(cronEn.fields![0]).toEqual({ k: 'When', v: 'On Monday 09:30 · Scheduler local timezone' });
    } finally {
      window.localStorage.removeItem('cat-cafe:shell-language');
    }
  });

  it('ignores stale/superseded reread failures and never leaves unavailable error once proposal loads', async () => {
    const proposal = scheduleProposal('pending');
    const hubItem = scheduleItem(proposal);

    // 1. Calling reread before ownerUserId is available must NOT stick unavailable error
    vi.spyOn(apiSessionIdentity, 'getSnapshot').mockReturnValue({
      ownerUserId: null,
      generation: 1,
    });
    const { result, rerender } = renderHook(() =>
      useScheduleApprovalController({
        block: scheduleBlock,
        messageId: coordinate.messageId,
        coordinate,
        readEnabled: false,
      }),
    );
    await act(async () => {
      result.current.reread();
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();

    // 2. When owner resolves and a newer reread supersedes an earlier in-flight reread, error stays null
    vi.spyOn(apiSessionIdentity, 'getSnapshot').mockReturnValue({
      ownerUserId: proposal.ownerUserId,
      generation: 2,
    });
    let resolveFirst!: (value: Response) => void;
    let callCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/session')) {
        return new Response(JSON.stringify({ userId: proposal.ownerUserId }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/approval-hub/pending')) {
        return new Response(
          JSON.stringify({ items: [hubItem], count: 1, identity: { ownerUserId: proposal.ownerUserId } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes(`/api/schedule-proposals/${proposal.proposalId}`)) {
        callCount++;
        if (callCount === 1) {
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return new Response(JSON.stringify({ proposal }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    useApprovalHubStore.setState({ items: [], count: 0, pendingReadAvailable: false, isLoading: false, error: null });

    await act(async () => {
      rerender();
    });
    await act(async () => {
      // Trigger two overlapping rereads: the 2nd supersedes the 1st
      result.current.reread();
      await Promise.resolve();
      result.current.reread();
      await new Promise((r) => setTimeout(r, 30));
      resolveFirst?.(
        new Response(JSON.stringify({ proposal }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(result.current.proposal?.proposalId).toBe(proposal.proposalId);
    expect(result.current.error).toBeNull();
  });
});
