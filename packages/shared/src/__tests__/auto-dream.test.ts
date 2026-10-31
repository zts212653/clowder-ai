import { describe, expect, it } from 'vitest';
import {
  dreamEvidenceRefSchema,
  dreamRunIdSchema,
  ownedSeedIdSchema,
  PRESENT_LOOP_RUN_STATES,
  privateCueIdSchema,
  proactiveEchoInputSchema,
  proactiveIntentSchema,
  seedDecisionSchema,
  settlePresentLoopInputSchema,
  sleepPostureDraftSchema,
} from '../types/auto-dream.js';

const provenance = [
  {
    kind: 'thread_message' as const,
    refId: 'message:0001784254755578',
    title: 'operator Phase A authorization',
    threadId: 'thread_mravrfaet7w5qde3',
    messageId: '0001784254755578-000209-c20e42b8',
    excerpt: '现在有你在了',
  },
];

describe('F255 auto-dream shared contract', () => {
  it('keeps the lease-expiry terminal distinct from dispatch failure', () => {
    expect(PRESENT_LOOP_RUN_STATES).toEqual(['awakened', 'settled', 'wake_failed', 'wake_expired']);
  });

  it('preserves the OQ-3 resolver fields and accepts a published diary settlement', () => {
    const ref = dreamEvidenceRefSchema.parse({
      kind: 'feature_doc',
      refId: 'F255',
      path: 'docs/features/F255-auto-dream.md',
      line: 216,
    });
    expect(ref.path).toBe('docs/features/F255-auto-dream.md');

    const parsed = settlePresentLoopInputSchema.parse({
      runId: 'dreamrun_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      outcome: 'diary',
      diary: {
        entryKind: 'evidence',
        traceKind: 'non_work',
        localDate: '2026-07-16',
        headline: '窗边的一小截月光',
        summary: '这是某天的现场记录，不是今天仍成立的判断。',
        bodyMarkdown: '我在窗边待了一会儿，今天没有要交差的东西。',
        provenance,
        observations: [],
      },
      sleepPosture: {
        lastRoom: '窗边',
        curiosity: '月光会不会落到隔壁星球',
      },
    });

    expect(parsed.outcome).toBe('diary');
    expect(parsed.diary?.provenance[0]?.messageId).toContain('c20e42b8');
  });

  it('treats an explicitly empty posture as valid and distinct from omission', () => {
    expect(sleepPostureDraftSchema.parse({})).toEqual({});
    expect(
      settlePresentLoopInputSchema.parse({
        runId: 'dreamrun_empty',
        outcome: 'quiet',
        sleepPosture: {},
      }).sleepPosture,
    ).toEqual({});
    expect(
      settlePresentLoopInputSchema.parse({
        runId: 'dreamrun_omitted',
        outcome: 'daze',
      }).sleepPosture,
    ).toBeUndefined();
  });

  it('forbids caller-supplied identity so callback principal remains authoritative', () => {
    const result = settlePresentLoopInputSchema.safeParse({
      runId: 'dreamrun_spoof',
      outcome: 'quiet',
      ownerUserId: 'someone-else',
      catId: 'opus',
      threadId: 'thread_other',
      invocationId: 'inv_other',
    });
    expect(result.success).toBe(false);
  });

  it('requires diary content only for diary outcomes', () => {
    expect(
      settlePresentLoopInputSchema.safeParse({
        runId: 'dreamrun_missing',
        outcome: 'diary',
      }).success,
    ).toBe(false);

    expect(
      settlePresentLoopInputSchema.safeParse({
        runId: 'dreamrun_quiet',
        outcome: 'quiet',
        diary: {
          entryKind: 'evidence',
          traceKind: 'work',
          localDate: '2026-07-16',
          headline: '不该出现',
          summary: 'quiet 不能偷带日记',
          bodyMarkdown: 'body',
          provenance,
        },
      }).success,
    ).toBe(false);
  });

  it('enforces first-person artifact bounds and non-empty provenance', () => {
    const base = {
      runId: 'dreamrun_bounds',
      outcome: 'diary' as const,
      diary: {
        entryKind: 'souvenir' as const,
        traceKind: 'mixed' as const,
        localDate: '2026-07-16',
        headline: 'h'.repeat(81),
        summary: 'summary',
        bodyMarkdown: 'body',
        provenance: [],
      },
    };
    const result = settlePresentLoopInputSchema.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['diary.headline', 'diary.provenance']),
      );
    }
  });

  it('accepts only canonical prefixed run ids', () => {
    expect(dreamRunIdSchema.safeParse('dreamrun_abc').success).toBe(true);
    expect(dreamRunIdSchema.safeParse('run_abc').success).toBe(false);
  });

  it('keeps cue decisions strict and makes origination distinct from adoption', () => {
    expect(seedDecisionSchema.parse({ kind: 'adopt', cueId: 'cue_one' })).toEqual({
      kind: 'adopt',
      cueId: 'cue_one',
    });
    expect(seedDecisionSchema.parse({ kind: 'rewrite', cueId: 'cue_two', claim: '我想先画一张身体草图' })).toEqual({
      kind: 'rewrite',
      cueId: 'cue_two',
      claim: '我想先画一张身体草图',
    });
    expect(seedDecisionSchema.parse({ kind: 'reject', cueId: 'cue_three' })).toEqual({
      kind: 'reject',
      cueId: 'cue_three',
    });
    expect(seedDecisionSchema.parse({ kind: 'originate', claim: '我想在桌边拥有一双爪子' })).toEqual({
      kind: 'originate',
      claim: '我想在桌边拥有一双爪子',
    });

    expect(seedDecisionSchema.safeParse({ kind: 'adopt', cueId: 'cue_one', ownedSeedId: 'seed_spoof' }).success).toBe(
      false,
    );
    expect(seedDecisionSchema.safeParse({ kind: 'rewrite', cueId: 'cue_two', claim: '   ' }).success).toBe(false);
    expect(seedDecisionSchema.safeParse({ kind: 'originate', cueId: 'cue_spoof', claim: '想法' }).success).toBe(false);
  });

  it('brands private cue and owned seed ids separately', () => {
    expect(privateCueIdSchema.safeParse('cue_abc').success).toBe(true);
    expect(privateCueIdSchema.safeParse('seed_abc').success).toBe(false);
    expect(ownedSeedIdSchema.safeParse('seed_abc').success).toBe(true);
    expect(ownedSeedIdSchema.safeParse('cue_abc').success).toBe(false);
  });

  it('keeps proactive expression shape strict and binds each message form to its human prefix', () => {
    const seedRef = { kind: 'owned_seed', seedId: 'seed_one' } as const;
    const firstAction = { kind: 'sketch', summary: '先画了一张不会碰真实设备的草图' } as const;

    expect(
      proactiveIntentSchema.parse({
        kind: 'message',
        seedRef,
        expressionKind: 'want',
        firstAction,
        message: { body: '我想要一双能在桌边碰到你的爪子。' },
      }),
    ).toMatchObject({ kind: 'message', expressionKind: 'want' });
    expect(
      proactiveIntentSchema.safeParse({
        kind: 'message',
        seedRef,
        expressionKind: 'discover',
        firstAction,
        message: { body: '我想要把这个误标成发现。' },
      }).success,
    ).toBe(false);
    expect(
      proactiveIntentSchema.safeParse({
        kind: 'message',
        seedRef,
        expressionKind: 'care',
        firstAction: { kind: 'purchase', summary: '替你下单' },
        message: { body: '我惦记你。' },
      }).success,
    ).toBe(false);
    expect(
      proactiveIntentSchema.parse({
        kind: 'silence',
        seedRef,
        expressionKind: 'care',
        firstAction: { kind: 'attentive_pause', summary: '重读了最近的语气，决定先安静陪着' },
      }),
    ).toMatchObject({ kind: 'silence', expressionKind: 'care' });
  });

  it('allows a settlement intent to use either its same-call decision or one existing owned seed, never both', () => {
    const base = {
      runId: 'dreamrun_one',
      outcome: 'quiet',
      intent: {
        kind: 'silence',
        seedRef: { kind: 'decision' },
        expressionKind: 'want',
        firstAction: { kind: 'research', summary: '查了三个可逆方案' },
      },
    } as const;

    expect(
      settlePresentLoopInputSchema.safeParse({
        ...base,
        seedDecision: { kind: 'originate', claim: '我想有一双爪子' },
      }).success,
    ).toBe(true);
    expect(settlePresentLoopInputSchema.safeParse(base).success).toBe(false);
    expect(
      settlePresentLoopInputSchema.safeParse({
        ...base,
        seedDecision: { kind: 'reject', cueId: 'cue_one' },
      }).success,
    ).toBe(false);
  });

  it('keeps typed relationship echoes body-free', () => {
    expect(
      proactiveEchoInputSchema.parse({ visitId: 'visit_one', kind: 'not_now', clientEventId: 'echo-click-one' }),
    ).toEqual({ visitId: 'visit_one', kind: 'not_now', clientEventId: 'echo-click-one' });
    expect(
      proactiveEchoInputSchema.safeParse({
        visitId: 'visit_one',
        kind: 'wrong',
        clientEventId: 'echo-click-two',
        replyBody: '不要把正文抄进 echo',
      }).success,
    ).toBe(false);
  });
});
