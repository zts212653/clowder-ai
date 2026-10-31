import type { ContentModificationRequestView } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { isSettledModification } from '../modification-polling';

type View = Pick<ContentModificationRequestView, 'stage' | 'execution'> & {
  record: Pick<ContentModificationRequestView['record'], 'control'>;
};

const cancelled = (taskResolution: 'unknown' | 'closing' | 'preserved' | 'closed' | 'owner_changed') => ({
  state: 'cancelled' as const,
  actorId: 'u',
  cancelledAt: 1,
  receiptRef: 'r',
  taskResolution,
});
const execution = (state: NonNullable<ContentModificationRequestView['execution']>['state']) => ({
  state,
  messageId: 'm',
  targetCatId: 'codex-sol',
  observedAt: 1,
  evidenceRef: 'e',
});
const settled = (view: View) => isSettledModification(view as ContentModificationRequestView);

// Dogfood 2026-09-22: a cancelled request whose Task had closed kept every mounted
// panel reading it every few seconds (200+ reads in minutes) with nothing left to change.
describe('isSettledModification', () => {
  it('settles a cancelled request only once its Task is closed and nothing is running', () => {
    expect(
      settled({ stage: 'cancelled', record: { control: cancelled('closed') }, execution: execution('failed') }),
    ).toBe(true);
    expect(settled({ stage: 'retired', record: {}, execution: undefined })).toBe(true);
  });

  // Review 2026-09-23 (codex6-sol): `preserved` means only this item was cancelled while the
  // shared Task stays open, and text respond checks the Task, not the request's control -
  // a later same-Task turn can still persist a candidate on this requestId. `owner_changed`
  // likewise leaves an open Task. Only a closed Task makes new candidates impossible.
  it('keeps reading a cancelled request whose Task can still accept candidates', () => {
    for (const resolution of ['preserved', 'owner_changed'] as const) {
      for (const state of ['finished', 'failed', 'cancelled', 'interrupted'] as const) {
        expect(
          settled({ stage: 'cancelled', record: { control: cancelled(resolution) }, execution: execution(state) }),
        ).toBe(false);
      }
    }
  });

  it('keeps reading while the Task outcome or the execution can still change', () => {
    expect(settled({ stage: 'cancelled', record: { control: cancelled('closing') }, execution: undefined })).toBe(
      false,
    );
    expect(settled({ stage: 'cancelled', record: { control: cancelled('unknown') }, execution: undefined })).toBe(
      false,
    );
    for (const state of ['queued', 'starting', 'running', 'withdrawn_running', 'unknown'] as const) {
      expect(
        settled({ stage: 'cancelled', record: { control: cancelled('closed') }, execution: execution(state) }),
      ).toBe(false);
    }
  });

  it('never settles a live request', () => {
    expect(settled({ stage: 'queued', record: {}, execution: execution('finished') })).toBe(false);
    expect(settled({ stage: 'pending_delivery', record: {}, execution: undefined })).toBe(false);
  });
});
