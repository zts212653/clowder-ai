import { describe, expect, it } from 'vitest';
import {
  routingContextReadModelV1Schema,
  routingPreferenceCreateCommandV1Schema,
  routingPreferenceRetireCommandV1Schema,
  routingPreferenceSupersedeCommandV1Schema,
  routingSignalCloseCommandV1Schema,
  routingSignalMarkCommandV1Schema,
} from '../types/routing-context-api.js';

const catSubject = { type: 'cat', catId: 'fable5' } as const;

describe('F293 Phase B routing product contracts', () => {
  it('accepts a bounded manual mark command without server-owned identity fields', () => {
    const command = {
      v: 1,
      commandId: 'cmd-signal-mark-1',
      subjectRef: catSubject,
      state: 'scarce',
      reasonCode: 'quota_low',
      note: '额度紧张',
      validUntil: 2_000,
    } as const;
    expect(routingSignalMarkCommandV1Schema.parse(command)).toEqual(command);
    expect(
      routingSignalMarkCommandV1Schema.safeParse({
        ...command,
        ownerId: 'another-owner',
        eventId: 'client-event',
        source: 'provider_error',
        observedAt: 1_000,
        evidenceRef: 'client:evidence',
      }).success,
    ).toBe(false);
  });

  it('requires a future boundary shape for a manual assertion', () => {
    expect(
      routingSignalMarkCommandV1Schema.safeParse({
        v: 1,
        commandId: 'cmd-signal-mark-2',
        subjectRef: catSubject,
        state: 'unavailable',
        reasonCode: 'provider_down',
      }).success,
    ).toBe(false);
  });

  it('keeps recover/retract commands causal but lets the server load the exact subject', () => {
    const close = {
      v: 1,
      commandId: 'cmd-signal-close-1',
      reasonCode: 'manual_confirmed',
      note: '人工确认',
    } as const;
    expect(routingSignalCloseCommandV1Schema.parse(close)).toEqual(close);
    expect(routingSignalCloseCommandV1Schema.safeParse({ ...close, subjectRef: catSubject }).success).toBe(false);
    expect(routingSignalCloseCommandV1Schema.safeParse({ ...close, closesSignalIds: ['signal-1'] }).success).toBe(
      false,
    );
  });

  it('separates create, exact-base supersede and terminal retirement commands', () => {
    const rule = {
      appliesWhen: { intent: 'review' as const },
      prefer: [{ type: 'cat' as const, catId: 'codex-terra' }],
      over: [{ type: 'cat' as const, catId: 'gpt52' }],
      rationale: '同价位时优先使用当前能力更匹配的猫。',
      evidenceRefs: ['message:preference-source'],
      reviewAfter: 5_000,
    };
    expect(
      routingPreferenceCreateCommandV1Schema.parse({
        v: 1,
        commandId: 'cmd-pref-create-1',
        ...rule,
      }),
    ).toMatchObject({ commandId: 'cmd-pref-create-1' });
    expect(
      routingPreferenceSupersedeCommandV1Schema.parse({
        v: 1,
        commandId: 'cmd-pref-update-1',
        baseRevisionId: 'pref-1:v1',
        baseVersion: 1,
        ...rule,
      }),
    ).toMatchObject({ baseRevisionId: 'pref-1:v1', baseVersion: 1 });
    expect(
      routingPreferenceRetireCommandV1Schema.parse({
        v: 1,
        commandId: 'cmd-pref-retire-1',
        baseRevisionId: 'pref-1:v2',
        baseVersion: 2,
        retirementReason: '经济性判断已经失效。',
      }),
    ).toMatchObject({ baseVersion: 2 });
    expect(
      routingPreferenceSupersedeCommandV1Schema.safeParse({
        v: 1,
        commandId: 'cmd-pref-update-2',
        ownerId: 'another-owner',
        preferenceId: 'client-chosen-chain',
        version: 9,
        ...rule,
      }).success,
    ).toBe(false);
  });

  it('validates a shared read model made from canonical Phase A records and projection', () => {
    const asserted = {
      v: 1,
      eventId: 'signal-1',
      commandId: 'cmd-signal-1',
      ownerId: 'owner-1',
      subjectRef: catSubject,
      reasonCode: 'quota_low',
      note: '额度紧张',
      source: 'manual_cvo',
      observedAt: 1_000,
      evidenceRef: 'routing-context:command:cmd-signal-1',
      eventType: 'asserted',
      state: 'scarce',
      validUntil: 2_000,
    } as const;
    const snapshot = {
      v: 1,
      ownerId: 'owner-1',
      observedAt: 1_500,
      catalogRevision: 'catalog:v1',
      candidates: [
        {
          binding: { v: 1, catId: 'fable5', providerId: 'anthropic', provenQuotaPools: [] },
          profile: { state: 'absent' as const },
          availability: 'scarce' as const,
          freshness: 'fresh' as const,
          reasons: [{ code: 'quota_low', summary: '额度紧张', sourceRefs: ['signal-1'] }],
          matchedPreferences: [],
          effect: 'advisory' as const,
        },
      ],
    } as const;
    const readModel = {
      v: 1,
      ownerId: 'owner-1',
      observedAt: 1_500,
      catalogRevision: 'catalog:v1',
      resolution: {
        state: 'fresh',
        snapshot,
        inputRevisionRef: 'sha256:input-1',
        sourceRefs: {
          signalEventIds: ['signal-1'],
          preferenceRevisionIds: [],
          dossierRevisions: [],
        },
      },
      signalEvents: [asserted],
      preferenceRevisions: [],
    } as const;
    expect(routingContextReadModelV1Schema.parse(readModel)).toEqual(readModel);
    expect(routingContextReadModelV1Schema.safeParse({ ...readModel, accountSource: 'private' }).success).toBe(false);
  });

  it('keeps canonical catalog bindings in degraded reads without inventing candidate state', () => {
    const degraded = {
      v: 1,
      ownerId: 'owner-1',
      observedAt: 1_500,
      catalogRevision: 'catalog:v2',
      resolution: {
        state: 'degraded',
        reason: 'built_in_profile_missing',
        affectedCatIds: ['glm52'],
        candidateBindings: [
          { v: 1, catId: 'fable5', providerId: 'anthropic', provenQuotaPools: [] },
          { v: 1, catId: 'glm52', providerId: 'zhipu', provenQuotaPools: [] },
        ],
      },
      signalEvents: [],
      preferenceRevisions: [],
    } as const;

    expect(routingContextReadModelV1Schema.parse(degraded)).toEqual(degraded);
    expect(
      routingContextReadModelV1Schema.safeParse({
        ...degraded,
        resolution: {
          ...degraded.resolution,
          candidateBindings: [degraded.resolution.candidateBindings[0], degraded.resolution.candidateBindings[0]],
        },
      }).success,
    ).toBe(false);
  });
});
