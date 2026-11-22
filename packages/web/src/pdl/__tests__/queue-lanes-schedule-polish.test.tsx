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

  it('constrains share-based lanes with minmax(0, Nfr) so long notices truncate instead of pushing queue off-edge', async () => {
    const { dom, evaluate } = await bootPdlEngine();
    try {
      const html = evaluate(`PDL_BLOCKS.lanes({
        lanes: [
          { share: 2, name: 'run', attach: 'straddle', items: [] },
          { share: 3, name: 'notice', align: 'center', items: [{ type: 'text', text: 'A very long notice title' }] },
          { share: 2, name: 'queue', align: 'end', attach: 'straddle', items: [{ type: 'text', text: 'Queued' }] },
        ],
      }, {}, {})`) as string;
      expect(html).toContain('--lanes:minmax(0, 2fr) minmax(0, 3fr) minmax(0, 2fr)');
      expect(html).not.toContain('max-content');
    } finally {
      dom.window.close();
    }
  });

  it('does not eat clicks on action buttons inside orderable queue rows or tiny <4px pointer jitter', async () => {
    const { dom, w, evaluate } = await bootPdlEngine();
    try {
      const app = w.document.getElementById('app')!;
      app.innerHTML =
        '<div class="group lr-list" data-ocontainer="list:queue:t1" data-order-act="cafeQueueOrder">' +
        '<div class="lr qitem" data-okey="q1" data-edit="order">' +
        '<div class="lr-head">' +
        '<span class="lr-main"><span class="lr-title">Queued item</span></span>' +
        '<span class="lr-end"><span class="lr-acts">' +
        '<button type="button" class="btn btn-sm btn-icon" data-act="cafeQueue" data-v="edit" data-i="0">edit</button>' +
        '</span></span>' +
        '</div></div></div>';

      const clicks: Array<Record<string, unknown>> = [];
      evaluate('window.__clicks = []; A.cafeQueue = function (d) { window.__clicks.push(d); };');

      const btn = app.querySelector('button[data-act="cafeQueue"]') as HTMLButtonElement;
      const row = app.querySelector('.lr.qitem') as HTMLElement;

      // 1. Hovering and clicking action button inside orderable row with 20px mouse movement must NOT enter drag or eat click
      btn.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 20 }));
      expect(row.style.cursor).toBe('');
      btn.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 100, clientY: 20 }));
      btn.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: 120, clientY: 20 }));
      btn.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 120, clientY: 20 }));
      btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 120, clientY: 20 }));
      expect(evaluate('window.__clicks.length')).toBe(1);

      // 2. Micro jitter (<4px) on the draggable row body itself must NOT start drag or eat clicks
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
      expect(clicks).toHaveLength(0);
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

  it('projects readable fields for create/delete schedule proposals without saying 原定时任务', () => {
    expect(scheduleApprovalCopy.zh.unavailable).not.toContain('原定时任务');
    expect(scheduleApprovalCopy.zh.checking).not.toContain('原定时任务');
    expect(scheduleApprovalCopy.zh.changed).not.toContain('原定时任务');

    const data = fixtureData();
    const proposal = scheduleProposal('pending');
    if (proposal.mutation.kind !== 'create') throw new Error('expected create fixture');
    proposal.mutation.task.trigger = { type: 'interval', ms: 1_200_000 };
    proposal.mutation.task.deliveryThreadId = data.threadId;
    proposal.mutation.task.params = { text: '巡检 RSI 评估项' };
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
    const card = chatModels(data, fixtureUi()).chatStream.items.find((item) => item.mid === 'reply-1')!.card as {
      fields?: Array<{ k: string; v: string }>;
    };
    expect(card.fields).toEqual([
      { k: '触发周期', v: '每 20 分钟' },
      { k: '送达对话', v: data.threads[0].title },
      { k: '模板', v: proposal.mutation.task.templateId },
      { k: '任务内容', v: '巡检 RSI 评估项' },
    ]);
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
