import { describe, expect, it } from 'vitest';
import { firstEntryBrowseKey, firstEntryKeys, firstEntryPhase } from './first-entry-model.js';

const identity = {
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  humanId: 'human_12345678',
};

describe('first Café entry guide', () => {
  it('keeps the unpaired entrance separate from Service health and waits for real participants after pairing', () => {
    const base = {
      embedded: true,
      ready: true,
      paired: false,
      entryDismissed: false,
      participantsLoaded: false,
      ownCatCount: 0,
      viewed: false,
      pairStarted: false,
      publishedCatCount: undefined,
      replaying: false,
      handoff: false,
    };
    expect(firstEntryPhase(base)).toBe('entry');
    expect(firstEntryPhase({ ...base, entryDismissed: true })).toBe('browsing');
    expect(firstEntryPhase({ ...base, paired: true })).toBe('loading');
    expect(firstEntryPhase({ ...base, paired: true, participantsLoaded: true })).toBe('empty');
    expect(firstEntryPhase({ ...base, paired: true, participantsLoaded: true, pairStarted: true })).toBe('loading');
    expect(
      firstEntryPhase({ ...base, paired: true, participantsLoaded: true, pairStarted: true, publishedCatCount: 1 }),
    ).toBe('loading');
    expect(
      firstEntryPhase({ ...base, paired: true, participantsLoaded: true, pairStarted: true, publishedCatCount: 0 }),
    ).toBe('empty');
    expect(firstEntryPhase({ ...base, paired: true, participantsLoaded: true, ownCatCount: 1 })).toBe('idle');
    expect(
      firstEntryPhase({ ...base, paired: true, participantsLoaded: true, ownCatCount: 1, pairStarted: true }),
    ).toBe('playing');
    expect(firstEntryPhase({ ...base, paired: true, participantsLoaded: true, ownCatCount: 1, viewed: true })).toBe(
      'idle',
    );
    expect(
      firstEntryPhase({ ...base, paired: true, participantsLoaded: true, ownCatCount: 1, viewed: true, handoff: true }),
    ).toBe('handoff');
    expect(firstEntryPhase({ ...base, embedded: false })).toBe('idle');
    expect(
      firstEntryPhase({
        ...base,
        paired: true,
        participantsLoaded: true,
        ownCatCount: 1,
        viewed: true,
        replaying: true,
      }),
    ).toBe('playing');
  });

  it('persists the viewed state against the exact connection, not a cat name or another Café', () => {
    const first = firstEntryKeys({ ...identity, connectionId: 'con_first0001' });
    const second = firstEntryKeys({ ...identity, connectionId: 'con_second001' });
    const otherHuman = firstEntryKeys({ ...identity, humanId: 'human_other123', connectionId: 'con_first0001' });
    expect(first?.viewed).not.toBe(second?.viewed);
    expect(first?.viewed).not.toBe(otherHuman?.viewed);
    expect(first?.entry).toBe(second?.entry);
    expect(first?.hint).not.toBe(second?.hint);
    expect(firstEntryBrowseKey(identity)).toBe(first?.entry);
    expect(firstEntryKeys({ ...identity, connectionId: undefined })).toBeUndefined();
  });
});
