import { describe, expect, it } from 'vitest';
import {
  companionIdentitySnapshotV1Schema,
  createCompanionIdentitySnapshot,
  projectCompanionIdentity,
} from '../concierge/companion-identity.js';

const xianxian = {
  displayName: '猫猫球',
  skin: 'xianxian-codex',
  duty: { catId: 'fable-5', displayName: '宪宪' },
  carrier: { catId: 'codex6-sol', displayName: '砚砚' },
  liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
} as const;

describe('companion identity snapshot', () => {
  it('uses the explicitly selected partner for the avatar and names both technical roles', () => {
    const snapshot = createCompanionIdentitySnapshot(xianxian);
    expect(snapshot).toEqual({
      v: 1,
      name: '猫猫球',
      partner: { catId: 'fable-5', displayName: '宪宪', skin: 'xianxian-codex' },
      live: { catId: 'codex6-sol', displayName: '砚砚', transport: 'gpt_live_v3', verifiedModel: null },
      deep: { catId: 'fable-5', displayName: '宪宪', verifiedModel: null },
    });
    expect(projectCompanionIdentity(snapshot)).toEqual({
      title: '猫猫球',
      partnerLabel: '宪宪陪伴中',
      avatarCatId: 'fable-5',
      skin: 'xianxian-codex',
      liveLabel: 'Live 快端：砚砚 · 型号未核实',
      deepLabel: '深思端：宪宪 · 型号未核实',
    });
  });

  it('keeps an old message on its saved identity after an explicit companion switch', () => {
    const oldMessage = createCompanionIdentitySnapshot(xianxian);
    const next = createCompanionIdentitySnapshot({
      ...xianxian,
      skin: 'yanyan-codex',
      duty: { catId: 'codex6-sol', displayName: '砚砚' },
    });
    expect(projectCompanionIdentity(oldMessage).avatarCatId).toBe('fable-5');
    expect(projectCompanionIdentity(next).avatarCatId).toBe('codex6-sol');
    expect(projectCompanionIdentity(oldMessage).partnerLabel).toBe('宪宪陪伴中');
  });

  it('requires real model evidence and rejects malformed history snapshots', () => {
    const snapshot = createCompanionIdentitySnapshot(xianxian);
    expect(projectCompanionIdentity(snapshot).liveLabel).toContain('型号未核实');
    expect(
      companionIdentitySnapshotV1Schema.safeParse({ ...snapshot, partner: { ...snapshot.partner, catId: '' } }).success,
    ).toBe(false);
    expect(companionIdentitySnapshotV1Schema.safeParse({ ...snapshot, authorCatId: 'fable-5' }).success).toBe(false);
  });
});
