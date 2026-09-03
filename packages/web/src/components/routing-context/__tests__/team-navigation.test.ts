import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  decodeTeamWorkspaceSubject,
  encodeTeamWorkspaceSubject,
  resolveTeamWorkspaceSubject,
} from '../team-navigation';

const readModel = {
  resolution: {
    state: 'fresh',
    snapshot: {
      candidates: [
        { binding: { catId: 'codex-sol', providerId: 'openai' } },
        { binding: { catId: 'opus5', providerId: 'anthropic' } },
      ],
    },
  },
} as RoutingContextReadModelV1;

describe('F293 Team navigation', () => {
  it('round-trips only typed cat and provider subjects', () => {
    expect(decodeTeamWorkspaceSubject(encodeTeamWorkspaceSubject({ type: 'cat', id: 'codex-sol' }))).toEqual({
      type: 'cat',
      id: 'codex-sol',
    });
    expect(decodeTeamWorkspaceSubject(encodeTeamWorkspaceSubject({ type: 'provider', id: 'openai' }))).toEqual({
      type: 'provider',
      id: 'openai',
    });
    expect(decodeTeamWorkspaceSubject('%7Bbad')).toBeNull();
    expect(
      decodeTeamWorkspaceSubject(encodeURIComponent(JSON.stringify({ type: 'quota_pool', id: 'shared' }))),
    ).toBeNull();
  });

  it('fails stale deep links closed to the Team list', () => {
    expect(resolveTeamWorkspaceSubject({ type: 'cat', id: 'codex-sol' }, readModel)).toEqual({
      type: 'cat',
      id: 'codex-sol',
    });
    expect(resolveTeamWorkspaceSubject({ type: 'provider', id: 'anthropic' }, readModel)).toEqual({
      type: 'provider',
      id: 'anthropic',
    });
    expect(resolveTeamWorkspaceSubject({ type: 'cat', id: 'retired-cat' }, readModel)).toBeNull();
    expect(resolveTeamWorkspaceSubject({ type: 'provider', id: 'unknown-provider' }, readModel)).toBeNull();
  });

  it('keeps a typed subject while routing truth is degraded instead of inventing a replacement', () => {
    const degraded = { resolution: { state: 'degraded' } } as RoutingContextReadModelV1;
    expect(resolveTeamWorkspaceSubject({ type: 'cat', id: 'codex-sol' }, degraded)).toEqual({
      type: 'cat',
      id: 'codex-sol',
    });
  });
});
