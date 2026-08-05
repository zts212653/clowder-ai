import { describe, expect, it } from 'vitest';
import { buildPolicy, resolveRoutingTarget } from '../HubRoutingPolicyTab';

const cats = [
  {
    id: 'opus',
    mentionPatterns: ['@opus'],
    roster: {
      family: 'ragdoll',
      roles: ['architect'],
      lead: true,
      available: false,
      successor: 'opus-5',
      evaluation: 'legacy',
    },
  },
  {
    id: 'opus-5',
    mentionPatterns: ['@opus5', '@opus-5'],
    roster: {
      family: 'ragdoll',
      roles: ['architect'],
      lead: true,
      available: true,
      evaluation: 'current',
    },
  },
];

describe('Hub routing policy successor', () => {
  it('uses the explicit available successor and its canonical catId handle', () => {
    expect(resolveRoutingTarget(cats, 'opus')).toEqual({ id: 'opus-5', mention: '@opus-5' });
  });

  it('fails closed when the configured successor is unavailable', () => {
    const unavailable = cats.map((cat) =>
      cat.id === 'opus-5' ? { ...cat, roster: { ...cat.roster, available: false } } : cat,
    );
    expect(resolveRoutingTarget(unavailable, 'opus')).toBeNull();
  });

  it('keeps a legacy target without roster metadata for backward compatibility', () => {
    const runtimeOnly = [{ id: 'runtime-opus', mentionPatterns: ['@runtime-opus'], roster: null }];
    expect(resolveRoutingTarget(runtimeOnly, 'runtime-opus')).toEqual({
      id: 'runtime-opus',
      mention: '@runtime-opus',
    });
  });

  it('persists the resolved catId instead of the disabled legacy id', () => {
    expect(buildPolicy({ reviewAvoidOpus: true, architecturePreferOpus: true, routingCatId: 'opus-5' })).toEqual({
      v: 1,
      scopes: {
        review: { avoidCats: ['opus-5'], reason: 'budget' },
        architecture: { preferCats: ['opus-5'] },
      },
    });
  });
});
