import { describe, expect, it } from 'vitest';
import { deriveEvalWorkspaceEvents } from '../eval-workspace/evalWorkspaceEvents';
import type { EvalDomainSummary, EvalHubItem, EvalHubSummary } from '../HubEvalTypes';

const baseDomain: EvalDomainSummary = {
  domainId: 'eval:a2a',
  displayName: 'A2A Harness Eval',
  descriptionForHuman: '猫和猫协作顺不顺',
  metricGlossary: {
    'c2.verdict_without_pass_count': {
      label: '有结论但没传球',
      means: '结论已经给出，却没有交给下一棒或合法持球的次数。',
      goodDirection: 'lower',
    },
  },
  systemThreadId: 'thread-a2a',
  frequency: 'daily',
  evalCatId: 'codex',
  evalCatHandle: '@codex',
  enabled: true,
  hasVerdict: true,
  latestVerdictId: 'verdict-a',
  latestVerdict: 'fix',
};

const baseItem: EvalHubItem = {
  id: 'verdict-a',
  domainId: 'eval:a2a',
  packetId: 'packet-a',
  feedbackType: 'live-verdict',
  verdict: 'fix',
  phenomenon: 'A2A handoff dropped after verdict',
  operatorNarrative: {
    headline: '发现 1 个需要修复的问题',
    summary: 'A2A 传球出现掉球。',
    action: '请负责 F167 的猫修复现有问题；修完后再复评。',
    nextCheck: '改动完成后，用同一组指标确认问题是否消失。',
    evidenceQuality: 'usable',
  },
  ownerAsk: 'Fix route exit handling.',
  harnessUnderEval: {
    featureId: 'F167',
    componentId: 'route-exit',
    name: 'Route exit guard',
  },
  reeval: {
    nextEvalAt: '2026-07-06T00:00:00.000Z',
    status: 'pending_owner',
    summary: 'next eval no longer reports dropped handoff',
  },
  lifecycle: {
    availability: 'available',
    ownerResponseStatus: 'not_started',
    closureStatus: 'open',
    reevalStatus: 'not_requested',
    stale: false,
  },
  evidence: {
    snapshotRefs: ['snapshot:a2a'],
    attributionRefs: ['attribution:a2a'],
    metricRefs: ['metric:c2.verdict_without_pass_count'],
    otherRefs: [],
  },
  trend: {
    generatedAt: '2026-07-05T00:00:00.000Z',
    window: { durationHours: 24 },
    components: [],
  },
  systemWorkspace: {
    kind: 'eval_domain',
    id: 'eval:a2a',
    label: 'A2A Harness Eval',
    threadId: 'thread-a2a',
    stateSot: 'registry',
  },
  source: {
    verdictPath: 'docs/harness-feedback/verdicts/a2a.md',
    bundleDir: 'docs/harness-feedback/bundles/a2a',
  },
};

function summaryWith(items: EvalHubItem[], domains: EvalDomainSummary[] = [baseDomain]): EvalHubSummary {
  return {
    counts: {
      total: items.length,
      actionable: items.filter((item) => item.verdict !== 'keep_observe').length,
      keepObserve: items.filter((item) => item.verdict === 'keep_observe').length,
      stale: items.filter((item) => item.lifecycle.stale).length,
      registeredDomains: domains.length,
    },
    domains,
    items,
  };
}

describe('deriveEvalWorkspaceEvents', () => {
  it('turns delete_sunset verdicts into decision events', () => {
    const [event] = deriveEvalWorkspaceEvents(
      summaryWith([
        {
          ...baseItem,
          verdict: 'delete_sunset',
          operatorNarrative: { ...baseItem.operatorNarrative, headline: '这项评估可能可以停用' },
          lifecycle: { ...baseItem.lifecycle, stale: false },
        },
      ]),
    );
    expect(event.kind).toBe('needs_decision');
    expect(event.severity).toBe('critical');
    expect(event.title).toContain('可以停用');
  });

  it('prioritizes stale lifecycle over delete_sunset decisions', () => {
    const [event] = deriveEvalWorkspaceEvents(
      summaryWith([{ ...baseItem, verdict: 'delete_sunset', lifecycle: { ...baseItem.lifecycle, stale: true } }]),
    );
    expect(event.kind).toBe('awaiting_reeval');
    expect(event.severity).toBe('attention');
    expect(event.stale).toBe(true);
  });

  it('prioritizes pending re-eval over delete_sunset decisions', () => {
    const [event] = deriveEvalWorkspaceEvents(
      summaryWith([
        { ...baseItem, verdict: 'delete_sunset', reeval: { ...baseItem.reeval, status: 'pending_reeval' } },
      ]),
    );
    expect(event.kind).toBe('awaiting_reeval');
    expect(event.severity).toBe('attention');
  });

  it('turns fix/build verdicts into action events', () => {
    const [event] = deriveEvalWorkspaceEvents(summaryWith([baseItem]));
    expect(event.kind).toBe('needs_action');
    expect(event.severity).toBe('attention');
    expect(event.action).toContain('负责 F167 的猫');
    expect(event.metricGlossary?.['c2.verdict_without_pass_count']?.label).toBe('有结论但没传球');
  });

  it('prioritizes stale lifecycle as awaiting re-eval', () => {
    const [event] = deriveEvalWorkspaceEvents(
      summaryWith([{ ...baseItem, lifecycle: { ...baseItem.lifecycle, stale: true } }]),
    );
    expect(event.kind).toBe('awaiting_reeval');
    expect(event.stale).toBe(true);
  });

  it('uses only the active canonical cycle due date for lifecycle-backed events', () => {
    const [pending] = deriveEvalWorkspaceEvents(
      summaryWith([
        {
          ...baseItem,
          lifecycle: {
            ...baseItem.lifecycle,
            ownerResponseStatus: 'acknowledged',
            closureStatus: 'reeval_pending',
            reevalStatus: 'pending',
            reevalDueAt: '2026-07-25T00:00:00.000Z',
          },
        },
      ]),
    );
    expect(pending.kind).toBe('awaiting_reeval');
    expect(pending.nextEvalAt).toBe('2026-07-25T00:00:00.000Z');

    const [resolved] = deriveEvalWorkspaceEvents(
      summaryWith([
        {
          ...baseItem,
          lifecycle: {
            ...baseItem.lifecycle,
            ownerResponseStatus: 'acknowledged',
            closureStatus: 'resolved',
            reevalStatus: 'passed',
          },
        },
      ]),
    );
    expect(resolved.kind).toBe('resolved');
    expect(resolved.nextEvalAt).toBeUndefined();
  });

  it('derives explicit escalation and terminal kinds from canonical lifecycle state', () => {
    const [escalated] = deriveEvalWorkspaceEvents(
      summaryWith([
        {
          ...baseItem,
          lifecycle: {
            availability: 'available',
            ownerResponseStatus: 'not_started',
            closureStatus: 'escalated',
            stale: true,
            targetOwnerCatId: 'codex-sol',
            reevalStatus: 'not_requested',
            escalation: { eventId: 'sla', stage: 'acknowledgement', dueAt: '2026-07-07T00:00:00.000Z' },
          },
        },
      ]),
    );
    expect(escalated.kind).toBe('escalated');
    expect(escalated.lifecycle.targetOwnerCatId).toBe('codex-sol');

    const [resolved] = deriveEvalWorkspaceEvents(
      summaryWith([
        {
          ...baseItem,
          lifecycle: {
            availability: 'available',
            ownerResponseStatus: 'acknowledged',
            closureStatus: 'resolved',
            stale: false,
            targetOwnerCatId: 'codex-sol',
            reevalStatus: 'passed',
            closureReason: 'verified clean',
          },
        },
      ]),
    );
    expect(resolved.kind).toBe('resolved');
    expect(resolved.lifecycle.closureReason).toBe('verified clean');

    const [suppressed] = deriveEvalWorkspaceEvents(
      summaryWith([
        {
          ...baseItem,
          lifecycle: {
            availability: 'available',
            ownerResponseStatus: 'not_started',
            closureStatus: 'suppressed_with_reason',
            stale: false,
            reevalStatus: 'not_requested',
            closureReason: 'operator accepted the known tradeoff',
          },
        },
      ]),
    );
    expect(suppressed.kind).toBe('resolved');
    expect(suppressed.lifecycle.closureStatus).toBe('suppressed_with_reason');
  });

  it('keeps keep_observe verdicts visible as quiet checking evidence', () => {
    const [event] = deriveEvalWorkspaceEvents(
      summaryWith([
        {
          ...baseItem,
          verdict: 'keep_observe',
          operatorNarrative: {
            headline: '这轮没有发现要处理的问题',
            summary: 'A2A 最近没有可处理问题；继续观察。',
            action: '现在不用处理；保持观察即可。',
            nextCheck: '按现有频率继续观察。',
            evidenceQuality: 'usable',
          },
          ownerAsk: 'No action required; keep observing.',
          reeval: { ...baseItem.reeval, status: 'observing' },
          lifecycle: {
            availability: 'not_required',
            ownerResponseStatus: 'not_required',
            closureStatus: 'observing',
            reevalStatus: 'not_required',
            stale: false,
          },
        },
      ]),
    );
    expect(event.kind).toBe('watching');
    expect(event.severity).toBe('info');
    expect(event.summary).toContain('没有可处理问题');
  });

  it('surfaces a failed keep-observe cadence that reopened into repair', () => {
    const [event] = deriveEvalWorkspaceEvents(
      summaryWith([
        {
          ...baseItem,
          verdict: 'keep_observe',
          lifecycle: {
            ...baseItem.lifecycle,
            closureStatus: 'open',
            repairDebtStatus: 'active',
            reevalDebtStatus: 'failed',
            reevalStatus: 'failed',
            stale: false,
          },
        },
      ]),
    );
    expect(event.kind).toBe('needs_action');
    expect(event.severity).toBe('attention');
  });

  it('only projects the latest verdict for each domain into workspace events', () => {
    const historicalFix: EvalHubItem = {
      ...baseItem,
      id: 'verdict-old',
      verdict: 'fix',
      operatorNarrative: { ...baseItem.operatorNarrative, summary: 'A2A 旧问题曾经需要修复。' },
      ownerAsk: 'Fix the old issue.',
    };
    const latestObserve: EvalHubItem = {
      ...baseItem,
      id: 'verdict-latest',
      verdict: 'keep_observe',
      operatorNarrative: {
        headline: '这轮没有发现要处理的问题',
        summary: 'A2A 最新评估已经没有可处理问题；继续观察。',
        action: '现在不用处理；保持观察即可。',
        nextCheck: '按现有频率继续观察。',
        evidenceQuality: 'usable',
      },
      ownerAsk: 'No action required; keep observing.',
      lifecycle: {
        availability: 'not_required',
        ownerResponseStatus: 'not_required',
        closureStatus: 'observing',
        reevalStatus: 'not_required',
        stale: false,
      },
      reeval: { ...baseItem.reeval, status: 'observing' },
    };
    const domain: EvalDomainSummary = {
      ...baseDomain,
      latestVerdictId: latestObserve.id,
      latestVerdict: latestObserve.verdict,
    };

    const events = deriveEvalWorkspaceEvents(summaryWith([historicalFix, latestObserve], [domain]));

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('verdict-latest');
    expect(events[0]?.kind).toBe('watching');
    expect(events[0]?.summary).toContain('最新评估');
  });

  it('uses domain summaries instead of hardcoded domain ids', () => {
    const domain: EvalDomainSummary = {
      ...baseDomain,
      domainId: 'eval:new-domain',
      displayName: 'New Domain Eval',
      systemThreadId: 'thread-new',
    };
    const [event] = deriveEvalWorkspaceEvents(summaryWith([{ ...baseItem, domainId: 'eval:new-domain' }], [domain]));
    expect(event.domainDisplayName).toBe('New Domain Eval');
    expect(event.systemThreadId).toBe('thread-new');
  });
});
