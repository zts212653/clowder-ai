import type { FreshnessCarrierCapability, QueueAuthorIntentReceipt, QueueMessageReceipt } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { humanCarrierLabel, intentChip, secondaryTruth } from '../message-disposition-presentation';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

const NOW = Date.now();

const EXACT_CAP: FreshnessCarrierCapability = {
  provider: 'openai_codex',
  carrier: 'codex_app_server',
  deliverySemantics: 'exact_active_turn',
};
const UNSUPPORTED_CAP: FreshnessCarrierCapability = {
  provider: 'kimi',
  carrier: 'kimi_stream_json',
  deliverySemantics: 'unsupported',
};
const UNDECLARED_CAP: FreshnessCarrierCapability = {
  provider: 'other',
  carrier: 'other',
  deliverySemantics: 'undeclared',
};

function makeIntent(
  requested: QueueAuthorIntentReceipt['requested'],
  effective: QueueAuthorIntentReceipt['effective'],
  extra?: Partial<QueueAuthorIntentReceipt>,
): QueueAuthorIntentReceipt {
  return { requested, effective, ...extra };
}

function makeReceipt(
  targets: Array<{
    catId: string;
    state?: QueueMessageReceipt['targets'][number]['state'];
    authorIntent?: QueueAuthorIntentReceipt;
  }>,
): QueueMessageReceipt {
  return {
    version: 1,
    entryId: 'q1',
    targets: targets.map((t) => ({
      catId: t.catId,
      state: t.state ?? 'queued',
      authorIntent: t.authorIntent,
    })),
    reminderAttempts: [],
  };
}

function makeEntry(
  id: string,
  opts: {
    content?: string;
    targetCats?: string[];
    queueReceipt?: QueueMessageReceipt;
    targetStates?: Record<string, string>;
    source?: QueueEntry['source'];
    callerCatId?: string;
  } = {},
): QueueEntry {
  return {
    id,
    threadId: 'thread-1',
    userId: 'u1',
    content: opts.content ?? 'test message',
    messageId: `m-${id}`,
    mergedMessageIds: [],
    source: opts.source ?? 'user',
    targetCats: opts.targetCats ?? ['opus'],
    intent: 'execute',
    status: 'queued',
    createdAt: NOW,
    targetStates: opts.targetStates as QueueEntry['targetStates'],
    queueReceipt: opts.queueReceipt,
    callerCatId: opts.callerCatId,
  };
}

describe('F264 Queue UX hierarchy — helper functions', () => {
  it('intentChip: continue_current → accent', () => {
    const chip = intentChip(makeIntent('continue_current', 'continue_current'));
    expect(chip.text).toBe('接着当前工作');
    expect(chip.tone).toBe('accent');
  });

  it('intentChip: next_work → neutral', () => {
    const chip = intentChip(makeIntent('next_work', 'next_work'));
    expect(chip.text).toBe('下一件工作');
    expect(chip.tone).toBe('neutral');
  });

  it('intentChip: fallback continue→next → amber', () => {
    const chip = intentChip(makeIntent('continue_current', 'next_work'));
    expect(chip.text).toBe('已转下一件工作');
    expect(chip.tone).toBe('amber');
  });

  it('secondaryTruth: undeclared support → fail-closed', () => {
    expect(secondaryTruth(makeIntent('continue_current', 'continue_current'), 'undeclared')).toBe(
      '能力未声明，按下一件工作处理',
    );
  });

  it('secondaryTruth: unsupported support → fail-closed', () => {
    expect(secondaryTruth(makeIntent('continue_current', 'continue_current'), 'unsupported')).toBe(
      '当前接入不支持本轮读取/提醒',
    );
  });

  it('secondaryTruth: exact + continue_current → 等待本轮读取', () => {
    expect(secondaryTruth(makeIntent('continue_current', 'continue_current'), 'exact')).toBe('等待本轮读取');
  });

  it('secondaryTruth: exact + fallback → 本轮未读到 with reason', () => {
    const truth = secondaryTruth(
      makeIntent('continue_current', 'next_work', { fallbackReason: 'unsupported_carrier' }),
      'exact',
    );
    expect(truth).toContain('本轮未读到');
    expect(truth).toContain('接入不支持');
  });

  it('humanCarrierLabel: no raw enum on surface', () => {
    expect(humanCarrierLabel(EXACT_CAP)).toBe('支持本轮读取');
    expect(humanCarrierLabel(UNSUPPORTED_CAP)).toBe('当前接入不支持本轮读取');
    expect(humanCarrierLabel(UNDECLARED_CAP)).toBe('能力未声明');
    expect(humanCarrierLabel(undefined)).toBe('能力未声明');
  });
});

describe('F264 Queue UX hierarchy — component claims', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      messages: [],
      queue: [],
      queuePaused: false,
      currentThreadId: 'thread-1',
      activeInvocations: {},
      catInvocations: {},
      targetCats: [],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function renderQueuePanel() {
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });
  }

  // Claim 1: continue-current vs next-work distinguishable without reading content
  it('claim 1: continue_current and next_work produce different visible text', () => {
    const continueEntry = makeEntry('q-continue', {
      content: '继续工作消息',
      targetCats: ['opus'],
      targetStates: { opus: 'queued' },
      queueReceipt: makeReceipt([
        {
          catId: 'opus',
          authorIntent: makeIntent('continue_current', 'continue_current', { carrierCapability: EXACT_CAP }),
        },
      ]),
    });
    const nextEntry = makeEntry('q-next', {
      content: '下一件工作消息',
      targetCats: ['opus'],
      targetStates: { opus: 'queued' },
      queueReceipt: makeReceipt([
        {
          catId: 'opus',
          authorIntent: makeIntent('next_work', 'next_work', { carrierCapability: EXACT_CAP }),
        },
      ]),
    });
    useChatStore.setState({ queue: [continueEntry, nextEntry] });
    renderQueuePanel();

    const text = container.textContent ?? '';
    expect(text).toContain('接着当前工作');
    expect(text).toContain('下一件工作');
  });

  it('source contract: legacy user missing intent keeps next-work compatibility', () => {
    const legacyUser = makeEntry('q-legacy-user', {
      source: 'user',
      targetStates: { opus: 'queued' },
    });
    useChatStore.setState({ queue: [legacyUser] });
    renderQueuePanel();

    expect(container.querySelector('[data-testid="intent-chip-q-legacy-user-opus"]')?.textContent).toBe('下一件工作');
  });

  it.each([
    'agent',
    'connector',
  ] as const)('source contract: %s custody does not render a human author-intent chip', (source) => {
    const nonHuman = makeEntry(`q-${source}`, {
      source,
      targetStates: { opus: 'queued' },
    });
    useChatStore.setState({ queue: [nonHuman] });
    renderQueuePanel();

    expect(container.querySelector(`[data-testid="intent-chip-q-${source}-opus"]`)).toBeNull();
    expect(container.textContent).not.toContain('下一件工作');
    expect(container.textContent).not.toContain('接着当前工作');
  });

  // Claim 2: raw provider/carrier/semantics not in visible surface by default
  it('claim 2: raw enums (openai_codex, codex_app_server, exact_active_turn) not visible by default', () => {
    const entry = makeEntry('q-raw', {
      content: 'test raw enum hiding',
      targetCats: ['opus'],
      targetStates: { opus: 'queued' },
      queueReceipt: makeReceipt([
        {
          catId: 'opus',
          authorIntent: makeIntent('continue_current', 'continue_current', { carrierCapability: EXACT_CAP }),
        },
      ]),
    });
    useChatStore.setState({ queue: [entry] });
    renderQueuePanel();

    const detailsClone = container.cloneNode(true) as HTMLElement;
    detailsClone.querySelectorAll('details').forEach((detail) => {
      detail.remove();
    });
    const surfaceText = detailsClone.textContent ?? '';
    expect(surfaceText).not.toContain('openai_codex');
    expect(surfaceText).not.toContain('codex_app_server');
    expect(surfaceText).not.toContain('exact_active_turn');
  });

  // Claim 3: requested-current → fallback-next preserves historical intent + real fallback
  it('claim 3: fallback continue→next shows 已转下一件工作 and 本轮未读到', () => {
    const entry = makeEntry('q-fallback', {
      content: 'fallback test',
      targetCats: ['opus'],
      targetStates: { opus: 'queued' },
      queueReceipt: makeReceipt([
        {
          catId: 'opus',
          authorIntent: makeIntent('continue_current', 'next_work', {
            carrierCapability: EXACT_CAP,
            fallbackReason: 'unsupported_carrier',
          }),
        },
      ]),
    });
    useChatStore.setState({ queue: [entry] });
    renderQueuePanel();

    const text = container.textContent ?? '';
    expect(text).toContain('已转下一件工作');
    expect(text).toContain('本轮未读到');
  });

  // Claim 4: unsupported/undeclared: explicitly fail-closed, no clickable Reminder
  it('claim 4: undeclared capability shows fail-closed text and no Reminder button', () => {
    const entry = makeEntry('q-undeclared', {
      content: 'undeclared test',
      targetCats: ['opus'],
      targetStates: { opus: 'queued' },
      queueReceipt: makeReceipt([
        {
          catId: 'opus',
          authorIntent: makeIntent('continue_current', 'continue_current', { carrierCapability: UNDECLARED_CAP }),
        },
      ]),
    });
    useChatStore.setState({ queue: [entry] });
    renderQueuePanel();

    const text = container.textContent ?? '';
    expect(text).toContain('能力未声明');
    const remindBtn = container.querySelector('[data-testid^="remind-"]');
    expect(remindBtn).toBeNull();
  });

  it('claim 4b: unsupported fail-closed text appears exactly once per target row', () => {
    const entry = makeEntry('q-unsupported-dup', {
      content: 'unsupported dup test',
      targetCats: ['kimi'],
      targetStates: { kimi: 'queued' },
      queueReceipt: makeReceipt([
        {
          catId: 'kimi',
          authorIntent: makeIntent('next_work', 'next_work', { carrierCapability: UNSUPPORTED_CAP }),
        },
      ]),
    });
    useChatStore.setState({
      queue: [entry],
      activeInvocations: {
        'inv-kimi': { catId: 'kimi', mode: 'interactive', startedAt: NOW },
      },
      catInvocations: {
        kimi: {
          invocationId: 'inv-kimi',
          turnInvocationId: 'inv-kimi',
          freshnessCarrierCapability: UNSUPPORTED_CAP,
        },
      },
    });
    renderQueuePanel();

    const detailsClone = container.cloneNode(true) as HTMLElement;
    detailsClone.querySelectorAll('details').forEach((detail) => {
      detail.remove();
    });
    const surfaceText = detailsClone.textContent ?? '';
    const matches = surfaceText.match(/当前接入不支持本轮/g) ?? [];
    expect(matches.length).toBe(1);
  });

  // Claim 5: exact eligible target shows Reminder
  it('claim 5: exact eligible target shows Reminder button', () => {
    const entry = makeEntry('q-exact', {
      content: 'exact reminder test',
      targetCats: ['opus'],
      targetStates: { opus: 'queued' },
      queueReceipt: makeReceipt([
        {
          catId: 'opus',
          authorIntent: makeIntent('continue_current', 'continue_current', { carrierCapability: EXACT_CAP }),
        },
      ]),
    });
    useChatStore.setState({
      queue: [entry],
      activeInvocations: {
        'inv-1': { catId: 'opus', mode: 'interactive', startedAt: NOW },
      },
      catInvocations: {
        opus: {
          invocationId: 'inv-1',
          turnInvocationId: 'inv-1',
          freshnessCarrierCapability: EXACT_CAP,
        },
      },
    });
    renderQueuePanel();

    const remindBtn = container.querySelector('[data-testid^="remind-"]');
    expect(remindBtn).not.toBeNull();
  });

  // Claim 6: two targets generate two independent target rows
  it('claim 6: two targets produce independent target rows', () => {
    const entry = makeEntry('q-multi', {
      content: 'multi target test',
      targetCats: ['opus', 'kimi'],
      targetStates: { opus: 'queued', kimi: 'queued' },
      queueReceipt: makeReceipt([
        {
          catId: 'opus',
          authorIntent: makeIntent('continue_current', 'continue_current', { carrierCapability: EXACT_CAP }),
        },
        { catId: 'kimi', authorIntent: makeIntent('next_work', 'next_work', { carrierCapability: UNSUPPORTED_CAP }) },
      ]),
    });
    useChatStore.setState({
      queue: [entry],
      activeInvocations: {
        'inv-opus': { catId: 'opus', mode: 'interactive', startedAt: NOW },
        'inv-kimi': { catId: 'kimi', mode: 'interactive', startedAt: NOW },
      },
      catInvocations: {
        opus: {
          invocationId: 'inv-opus',
          turnInvocationId: 'inv-opus',
          freshnessCarrierCapability: EXACT_CAP,
        },
        kimi: {
          invocationId: 'inv-kimi',
          turnInvocationId: 'inv-kimi',
          freshnessCarrierCapability: UNSUPPORTED_CAP,
        },
      },
    });
    renderQueuePanel();

    const text = container.textContent ?? '';
    expect(text).toContain('接着当前工作');
    expect(text).toContain('下一件工作');
    expect(text).toContain('当前接入不支持');
  });

  // Claim 7: Steer button still present with correct testid
  it('claim 7: Steer button retains data-testid and aria', () => {
    const entry = makeEntry('q-steer', {
      content: 'steer test',
      targetCats: ['opus'],
      targetStates: { opus: 'queued' },
    });
    useChatStore.setState({ queue: [entry] });
    renderQueuePanel();

    const steerBtn = container.querySelector('[data-testid^="steer-"]');
    expect(steerBtn).not.toBeNull();
    expect(steerBtn?.getAttribute('aria-label')).toBe('Steer');
  });
});
