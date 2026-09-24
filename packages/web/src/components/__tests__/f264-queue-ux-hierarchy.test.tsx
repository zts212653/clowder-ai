import type { FreshnessCarrierCapability, QueueAuthorIntentReceipt } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import {
  authorIntentLabel,
  classifyFreshnessCarrierSupport,
  humanCarrierLabel,
  intentChip,
  parseFreshnessCarrierCapability,
  secondaryTruth,
} from '../message-disposition-presentation';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

const NOW = Date.now();

const EXACT_CAP: FreshnessCarrierCapability = {
  provider: 'openai_codex',
  carrier: 'codex_app_server',
  deliverySemantics: 'exact_active_turn',
  activeInvocationGuidance: 'supported',
};
const UNSUPPORTED_CAP: FreshnessCarrierCapability = {
  provider: 'kimi',
  carrier: 'kimi_stream_json',
  deliverySemantics: 'unsupported',
  activeInvocationGuidance: 'unsupported',
};
const QUEUED_INTERNAL_CAP: FreshnessCarrierCapability = {
  provider: 'anthropic',
  carrier: 'claude_agent_sdk',
  deliverySemantics: 'queued_internal_turn',
  activeInvocationGuidance: 'supported',
};
const UNDECLARED_CAP: FreshnessCarrierCapability = {
  provider: 'other',
  carrier: 'other',
  deliverySemantics: 'undeclared',
  activeInvocationGuidance: 'undeclared',
};
const EXACT_WITHOUT_GUIDANCE_CAP: FreshnessCarrierCapability = {
  provider: 'openai_codex',
  carrier: 'codex_app_server',
  deliverySemantics: 'exact_active_turn',
  activeInvocationGuidance: 'unsupported',
};

function makeIntent(
  requested: QueueAuthorIntentReceipt['requested'],
  effective: QueueAuthorIntentReceipt['effective'],
  extra?: Partial<QueueAuthorIntentReceipt>,
): QueueAuthorIntentReceipt {
  return { requested, effective, ...extra };
}

function makeAuthorIntents(
  targets: Array<{
    catId: string;
    authorIntent?: QueueAuthorIntentReceipt;
  }>,
): Record<string, QueueAuthorIntentReceipt> {
  return Object.fromEntries(
    targets.flatMap((target) => (target.authorIntent ? [[target.catId, target.authorIntent] as const] : [])),
  );
}

function makeEntry(
  id: string,
  opts: {
    content?: string;
    targetCats?: string[];
    authorIntentByTarget?: Record<string, QueueAuthorIntentReceipt>;
    source?: 'user' | 'agent' | 'connector';
    callerCatId?: string;
    recoveryActions?: QueueEntry['recoveryActions'];
  } = {},
): QueueEntry {
  return {
    id,
    threadId: 'thread-1',
    userId: 'u1',
    content: opts.content ?? 'test message',
    messageId: `m-${id}`,
    mergedMessageIds: [],
    from:
      opts.source === 'agent'
        ? { kind: 'agent', catId: opts.callerCatId ?? 'test-agent' }
        : opts.source === 'connector'
          ? { kind: 'external', connectorId: 'test-connector' }
          : { kind: 'user', userId: 'u1' },
    targetCats: opts.targetCats ?? ['opus'],
    intent: 'execute',
    status: 'queued',
    createdAt: NOW,
    authorIntentByTarget: opts.authorIntentByTarget,
    recoveryActions: opts.recoveryActions,
  };
}

describe('F264 Queue UX hierarchy — helper functions', () => {
  it('intentChip: continue_current → accent', () => {
    const chip = intentChip(makeIntent('continue_current', 'continue_current'));
    expect(chip.text).toBe('立即发送，引导回复');
    expect(chip.tone).toBe('accent');
  });

  it('intentChip: next_work → neutral', () => {
    const chip = intentChip(makeIntent('next_work', 'next_work'));
    expect(chip.text).toBe('排队等待');
    expect(chip.tone).toBe('neutral');
  });

  it('intentChip: fallback continue→next → amber', () => {
    const chip = intentChip(makeIntent('continue_current', 'next_work'));
    expect(chip.text).toBe('已转排队等待');
    expect(chip.tone).toBe('amber');
  });

  it('secondaryTruth: undeclared support → fail-closed', () => {
    expect(secondaryTruth(makeIntent('continue_current', 'continue_current'), 'undeclared')).toBe(
      '能力未声明，按排队等待处理',
    );
  });

  it('secondaryTruth: unsupported support → fail-closed', () => {
    expect(secondaryTruth(makeIntent('continue_current', 'continue_current'), 'unsupported')).toBe(
      '当前接入不支持引导回复',
    );
  });

  it('secondaryTruth: exact + continue_current → 等待当前回复读取', () => {
    expect(secondaryTruth(makeIntent('continue_current', 'continue_current'), 'exact')).toBe('等待当前回复读取');
  });

  it('secondaryTruth: queued + continue_current → 等待当前运行的下一内部轮次', () => {
    expect(secondaryTruth(makeIntent('continue_current', 'continue_current'), 'queued')).toBe(
      '等待当前运行的下一内部轮次',
    );
  });

  it('authorIntentLabel: queued guidance never claims exact current-turn reading', () => {
    expect(
      authorIntentLabel(makeIntent('continue_current', 'continue_current', { carrierCapability: QUEUED_INTERNAL_CAP })),
    ).toBe('立即发送，引导回复 · 等待当前运行的下一内部轮次');
  });

  it('secondaryTruth: exact + fallback → 当前回复未读到 with reason', () => {
    const truth = secondaryTruth(
      makeIntent('continue_current', 'next_work', { fallbackReason: 'unsupported_carrier' }),
      'exact',
    );
    expect(truth).toContain('当前回复未读到');
    expect(truth).toContain('接入不支持');
  });

  it('humanCarrierLabel: no raw enum on surface', () => {
    expect(humanCarrierLabel(EXACT_CAP)).toBe('支持引导当前回复');
    expect(humanCarrierLabel(QUEUED_INTERNAL_CAP)).toBe('支持引导当前运行（下一内部轮次，非精确同轮读取）');
    expect(humanCarrierLabel(UNSUPPORTED_CAP)).toBe('当前接入不支持引导当前回复');
    expect(humanCarrierLabel(EXACT_WITHOUT_GUIDANCE_CAP)).toBe('当前接入不支持引导当前回复');
    expect(humanCarrierLabel(UNDECLARED_CAP)).toBe('能力未声明');
    expect(humanCarrierLabel(undefined)).toBe('能力未声明');
  });

  it('keeps queued-internal guidance distinct from exact-turn freshness', () => {
    expect(parseFreshnessCarrierCapability(QUEUED_INTERNAL_CAP)).toEqual(QUEUED_INTERNAL_CAP);
    expect(classifyFreshnessCarrierSupport([QUEUED_INTERNAL_CAP])).toBe('queued');
    expect(classifyFreshnessCarrierSupport([EXACT_CAP, QUEUED_INTERNAL_CAP])).toBe('queued');
    expect(classifyFreshnessCarrierSupport([EXACT_WITHOUT_GUIDANCE_CAP])).toBe('unsupported');
    expect(
      parseFreshnessCarrierCapability({
        provider: 'anthropic',
        carrier: 'future_carrier',
        deliverySemantics: 'queued_internal_turn',
      }),
    ).toBeUndefined();
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

  // The Queue surface presents the delivery route; transport intent remains internal.
  it('claim 1: continue_current and next_work share the same concise route surface', () => {
    const continueEntry = makeEntry('q-continue', {
      content: '继续工作消息',
      targetCats: ['opus'],
      authorIntentByTarget: makeAuthorIntents([
        {
          catId: 'opus',
          authorIntent: makeIntent('continue_current', 'continue_current', { carrierCapability: EXACT_CAP }),
        },
      ]),
    });
    const nextEntry = makeEntry('q-next', {
      content: '下一件工作消息',
      targetCats: ['opus'],
      authorIntentByTarget: makeAuthorIntents([
        {
          catId: 'opus',
          authorIntent: makeIntent('next_work', 'next_work', { carrierCapability: EXACT_CAP }),
        },
      ]),
    });
    useChatStore.setState({ queue: [continueEntry, nextEntry] });
    renderQueuePanel();

    const text = container.textContent ?? '';
    expect(text).not.toContain('立即发送，引导回复');
    expect(text).not.toContain('排队等待');
    expect(container.querySelectorAll('[data-queue-target-row="opus"]')).toHaveLength(2);
  });

  it('source contract: legacy user missing intent still renders its route without an intent chip', () => {
    const legacyUser = makeEntry('q-legacy-user', {
      source: 'user',
    });
    useChatStore.setState({ queue: [legacyUser] });
    renderQueuePanel();

    expect(container.querySelector('[data-testid="intent-chip-q-legacy-user-opus"]')).toBeNull();
    expect(container.querySelector('[data-testid="queue-route-q-legacy-user"]')).not.toBeNull();
  });

  it.each([
    'agent',
    'connector',
  ] as const)('source contract: %s custody does not render a human author-intent chip', (source) => {
    const nonHuman = makeEntry(`q-${source}`, {
      source,
    });
    useChatStore.setState({ queue: [nonHuman] });
    renderQueuePanel();

    expect(container.querySelector(`[data-testid="intent-chip-q-${source}-opus"]`)).toBeNull();
    expect(container.textContent).not.toContain('排队等待');
    expect(container.textContent).not.toContain('立即发送，引导回复');
  });

  // Claim 2: raw provider/carrier/semantics not in visible surface by default
  it('claim 2: raw enums (openai_codex, codex_app_server, exact_active_turn) not visible by default', () => {
    const entry = makeEntry('q-raw', {
      content: 'test raw enum hiding',
      targetCats: ['opus'],
      authorIntentByTarget: makeAuthorIntents([
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

  // Routing fallback diagnostics remain available to telemetry, not the Queue row.
  it('claim 3: fallback continue→next does not leak transport diagnostics into the route surface', () => {
    const entry = makeEntry('q-fallback', {
      content: 'fallback test',
      targetCats: ['opus'],
      authorIntentByTarget: makeAuthorIntents([
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
    expect(text).not.toContain('已转排队等待');
    expect(text).not.toContain('当前回复未读到');
    expect(container.querySelector('[data-queue-target-row="opus"]')).not.toBeNull();
  });

  // Unsupported/undeclared carriers do not expose an inapplicable Reminder action.
  it('claim 4: undeclared capability stays internal and exposes no Reminder button', () => {
    const entry = makeEntry('q-undeclared', {
      content: 'undeclared test',
      targetCats: ['opus'],
      authorIntentByTarget: makeAuthorIntents([
        {
          catId: 'opus',
          authorIntent: makeIntent('continue_current', 'continue_current', { carrierCapability: UNDECLARED_CAP }),
        },
      ]),
    });
    useChatStore.setState({ queue: [entry] });
    renderQueuePanel();

    const text = container.textContent ?? '';
    expect(text).not.toContain('能力未声明');
    const remindBtn = container.querySelector('[data-testid^="remind-"]');
    expect(remindBtn).toBeNull();
  });

  it('claim 4b: unsupported fail-closed diagnostics stay off the target row', () => {
    const entry = makeEntry('q-unsupported-dup', {
      content: 'unsupported dup test',
      targetCats: ['kimi'],
      authorIntentByTarget: makeAuthorIntents([
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
    expect(surfaceText).not.toContain('当前接入不支持引导回复');
    expect(container.querySelector('[data-queue-target-row="kimi"]')).not.toBeNull();
  });

  // Claim 5: Queue exposes only canonical target/read truth; delivery mode lives in Steer.
  it('claim 5: exact eligible target has no reminder side-channel', () => {
    const entry = makeEntry('q-exact', {
      content: 'exact reminder test',
      targetCats: ['opus'],
      authorIntentByTarget: makeAuthorIntents([
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
    expect(remindBtn).toBeNull();
  });

  // Claim 6: two targets generate two independent target rows
  it('claim 6: two targets produce independent target rows', () => {
    const entry = makeEntry('q-multi', {
      content: 'multi target test',
      targetCats: ['opus', 'kimi'],
      authorIntentByTarget: makeAuthorIntents([
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

    expect(container.querySelectorAll('[data-queue-target-row]')).toHaveLength(2);
    const text = container.textContent ?? '';
    expect(text).not.toContain('立即发送，引导回复');
    expect(text).not.toContain('排队等待');
    expect(text).not.toContain('当前接入不支持');
    expect(container.querySelector('[data-testid="remind-q-multi-opus"]')).toBeNull();
    expect(container.querySelector('[data-testid="remind-q-multi-kimi"]')).toBeNull();
  });

  // Claim 7: Steer button still present with correct testid
  it('claim 7: Steer button retains data-testid and aria', () => {
    const entry = makeEntry('q-steer', {
      content: 'steer test',
      targetCats: ['opus'],
      recoveryActions: [
        {
          id: 'queue-steer:q-steer',
          entryId: 'q-steer',
          kind: 'steer',
          request: { method: 'POST', path: '/api/threads/thread-1/queue/q-steer/steer' },
        },
      ],
    });
    useChatStore.setState({ queue: [entry] });
    renderQueuePanel();

    const steerBtn = container.querySelector('[data-testid^="steer-"]');
    expect(steerBtn).not.toBeNull();
    expect(steerBtn?.getAttribute('aria-label')).toBe('Steer');
  });
});
