import {
  type ProviderSemanticEvent,
  resolveProviderSemanticMessage as resolveSharedProviderSemanticMessage,
} from '@cat-cafe/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { clearDebugEvents, configureDebug, dumpDebugEvents } from '../../debug/invocationEventDebug';
import { projectProviderSemanticEvent, resolveProviderSemanticMessage } from '../provider-semantic-registry';

const warning: ProviderSemanticEvent = {
  v: 1,
  id: 'warning-1',
  kind: 'warning',
  occurredAt: 1_788_000_000_000,
  category: 'deprecation',
  severity: 'warning',
  message: 'This provider path is deprecated.',
  provenance: { provider: 'codex', carrier: 'app_server', nativeType: 'deprecationNotice' },
};

describe('F306 provider semantic registry', () => {
  afterEach(() => {
    clearDebugEvents();
    configureDebug({ enabled: false });
  });

  it('projects user meaning without exposing native wire vocabulary', () => {
    const result = projectProviderSemanticEvent(warning);
    expect(result).toMatchObject({
      status: 'projected',
      surface: 'timeline',
      messageMode: 'replace',
      eventId: 'warning-1',
    });
    expect(result.status === 'projected' ? result.content : '').toBe('警告：This provider path is deprecated.');
    expect(JSON.stringify(result)).not.toContain('deprecationNotice');
  });

  it('owns one message-carrier policy for replacement, augmentation, entity state, and invalid payloads', () => {
    expect(resolveProviderSemanticMessage(warning)).toMatchObject({ action: 'replace' });
    expect(
      resolveProviderSemanticMessage({
        v: 1,
        id: 'diff-1',
        kind: 'diff',
        occurredAt: 1,
        stage: 'completed',
        summary: '2 files changed',
      }),
    ).toMatchObject({ action: 'augment' });
    expect(
      resolveProviderSemanticMessage({
        v: 1,
        id: 'goal-1',
        kind: 'goal',
        occurredAt: 1,
        state: 'updated',
        revision: 1,
        objective: 'Ship',
        source: 'codex_app_server',
        observedAt: 1,
      }),
    ).toEqual({ action: 'suppress', reason: 'non_message_surface' });
    expect(resolveProviderSemanticMessage({ method: 'raw/provider/wire' })).toEqual({
      action: 'suppress',
      reason: 'invalid_event',
    });
  });

  it('distinguishes an explicit timeline suppression from a non-message surface', () => {
    expect(
      resolveSharedProviderSemanticMessage(warning, {
        warning: (event) => ({
          surface: 'timeline',
          messageMode: 'suppress',
          content: event.message,
          severity: event.severity,
        }),
      }),
    ).toEqual({ action: 'suppress', reason: 'explicit_suppress' });
  });

  it('keeps plan visible in the timeline until a real Workspace host owns it', () => {
    const event = {
      v: 1 as const,
      id: 'plan-timeline-1',
      kind: 'plan' as const,
      occurredAt: 1,
      stage: 'updated' as const,
      text: '先定位，再修复',
    };

    expect(projectProviderSemanticEvent(event)).toMatchObject({
      status: 'projected',
      surface: 'timeline',
      messageMode: 'replace',
    });
    expect(resolveProviderSemanticMessage(event)).toMatchObject({
      action: 'replace',
      projection: { content: '先定位，再修复' },
    });
  });

  it.each([
    {
      v: 1 as const,
      id: 'guardian-workspace-1',
      kind: 'guardian' as const,
      occurredAt: 1,
      stage: 'completed' as const,
      outcome: 'pass' as const,
      summary: '守护检查通过',
    },
    {
      v: 1 as const,
      id: 'review-workspace-1',
      kind: 'review' as const,
      occurredAt: 1,
      reviewId: 'review-1',
      stage: 'result' as const,
      summary: '没有阻塞项',
    },
  ])('keeps hosted workspace-owned $kind state out of the timeline message carrier', (event) => {
    expect(projectProviderSemanticEvent(event)).toMatchObject({ status: 'projected', surface: 'workspace' });
    expect(resolveProviderSemanticMessage(event)).toEqual({
      action: 'suppress',
      reason: 'non_message_surface',
    });
  });

  it('records why a semantic carrier was suppressed without retaining provider wire content', () => {
    configureDebug({ enabled: true });

    resolveProviderSemanticMessage({ method: 'provider/raw/wire', secret: 'must-not-survive' });

    const dump = dumpDebugEvents({ rawThreadId: true });
    expect(dump.events).toContainEqual(
      expect.objectContaining({
        event: 'semantic_suppressed',
        action: 'suppress',
        reason: 'invalid_event',
        level: 'warn',
      }),
    );
    expect(JSON.stringify(dump)).not.toContain('must-not-survive');
  });

  it.each(['claude', 'gemini', 'kimi'])('does not branch projection on %s provenance', (provider) => {
    const result = projectProviderSemanticEvent({ ...warning, provenance: { provider } });
    expect(result).toEqual(projectProviderSemanticEvent({ ...warning, provenance: { provider: 'codex' } }));
  });

  it('fails closed when a historical payload is unregistered, malformed, or a projector throws', () => {
    expect(projectProviderSemanticEvent({ ...warning, kind: 'native_codex_warning' } as never)).toMatchObject({
      status: 'hidden_invalid',
    });
    expect(projectProviderSemanticEvent({ ...warning, message: '' } as never)).toMatchObject({
      status: 'hidden_invalid',
    });
    expect(
      projectProviderSemanticEvent(warning, {
        warning: () => {
          throw new Error('fixture');
        },
      }),
    ).toMatchObject({ status: 'hidden_invalid', reason: 'projector_error' });
  });

  it.each([
    { type: 'thinking', text: 'raw' },
    { type: 'context_presentation_receipt', receipt: {} },
    { type: 'context_continuity', mode: 'cold' },
    { type: 'provider_capability', capability: 'thinking' },
  ])('suppresses historical raw JSON rather than treating it as semantic UI copy', (payload) => {
    expect(projectProviderSemanticEvent(payload as never)).toMatchObject({ status: 'hidden_invalid' });
    expect(projectProviderSemanticEvent(payload as never)).not.toHaveProperty('content');
  });
});
