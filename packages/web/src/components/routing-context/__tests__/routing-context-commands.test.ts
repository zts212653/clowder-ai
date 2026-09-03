import type { RoutingPreferenceRevisionV1, RoutingSignalEventV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  buildRenewPreferenceCommand,
  buildSignalMarkCommand,
  openRoutingSignalAssertions,
  preferenceHeads,
} from '../routing-context-commands';

describe('F293 routing owner commands', () => {
  it('builds a bounded manual signal without caller-owned identity fields', () => {
    const command = buildSignalMarkCommand({
      commandId: 'cmd-1',
      subjectRef: { type: 'cat', catId: 'codex-sol' },
      state: 'unavailable',
      reasonCode: 'owner-maintenance',
      note: '正在维护',
      observedAt: 1_800_000_000_000,
      durationMs: 3_600_000,
    });

    expect(command).toEqual({
      v: 1,
      commandId: 'cmd-1',
      subjectRef: { type: 'cat', catId: 'codex-sol' },
      state: 'unavailable',
      reasonCode: 'owner-maintenance',
      note: '正在维护',
      validUntil: 1_800_003_600_000,
    });
    expect(command).not.toHaveProperty('ownerId');
    expect(command).not.toHaveProperty('source');
  });

  it('keeps expired assertions closable until one exact causal closer exists', () => {
    const asserted = {
      eventId: 'signal-1',
      eventType: 'asserted',
      subjectRef: { type: 'provider', providerId: 'openai' },
      state: 'degraded',
      observedAt: 100,
      validUntil: 200,
    } as RoutingSignalEventV1;
    const unrelated = {
      eventId: 'signal-2',
      eventType: 'retracted',
      closesSignalIds: ['other'],
      observedAt: 300,
    } as RoutingSignalEventV1;
    expect(openRoutingSignalAssertions([asserted, unrelated])).toEqual([asserted]);
    const closer = { ...unrelated, eventId: 'signal-3', closesSignalIds: ['signal-1'] } as RoutingSignalEventV1;
    expect(openRoutingSignalAssertions([asserted, unrelated, closer])).toEqual([]);
  });

  it('renews only from the exact active head and preserves its rule', () => {
    const v1 = {
      preferenceId: 'preference-1',
      revisionId: 'revision-1',
      version: 1,
      lifecycle: 'active',
      appliesWhen: { intent: 'review' },
      prefer: [{ type: 'cat', catId: 'opus5' }],
      over: [{ type: 'cat', catId: 'codex-sol' }],
      rationale: '终审优先',
      evidenceRefs: ['decision:F293'],
      validFrom: 100,
    } as RoutingPreferenceRevisionV1;
    const v2 = { ...v1, revisionId: 'revision-2', version: 2, supersedesRevisionId: 'revision-1' };

    expect(preferenceHeads([v2, v1])).toEqual([v2]);
    expect(buildRenewPreferenceCommand(v2, 'cmd-renew', 9_999)).toMatchObject({
      v: 1,
      commandId: 'cmd-renew',
      baseRevisionId: 'revision-2',
      baseVersion: 2,
      appliesWhen: { intent: 'review' },
      prefer: v2.prefer,
      over: v2.over,
      rationale: '终审优先',
      evidenceRefs: ['decision:F293'],
      reviewAfter: 9_999,
    });
  });
});
