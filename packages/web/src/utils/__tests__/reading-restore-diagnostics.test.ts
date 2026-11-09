import { afterEach, expect, it, vi } from 'vitest';
import * as transport from '../connection-diagnostics';
import { observeReadingRestore, recordReadingCancellation } from '../reading-restore-diagnostics';

const context = {
  bridgeId: '11111111-1111-4111-8111-111111111111',
  operationId: '22222222-2222-4222-8222-222222222222',
  readerId: '33333333-3333-4333-8333-333333333333',
};
const state = () => ({ readerMounted: true, refreshPending: false, restorePending: false, settlementPending: false });
afterEach(() => vi.restoreAllMocks());
it('does not log ordinary work, even during repeated no-op cancellations', async () => {
  const record = vi.spyOn(transport, 'recordConnectionDiagnostic');
  const receipt = { status: 'settled', exact: true } as const;
  expect(await observeReadingRestore(undefined, state, async () => receipt)).toBe(receipt);
  for (let i = 0; i < 500; i++)
    recordReadingCancellation([undefined, undefined], state, 'native_input', {
      inputKind: 'wheel',
      inputTrusted: false,
    });
  expect(record).not.toHaveBeenCalled();
});
it('diagnostic failure preserves the exact result and exception object', async () => {
  vi.spyOn(transport, 'recordConnectionDiagnostic').mockImplementation(() => {
    throw new Error('diagnostic failure');
  });
  const receipt = { status: 'interrupted' } as const;
  expect(await observeReadingRestore(context, state, async () => receipt)).toBe(receipt);
  const failure = new Error('original failure');
  await expect(
    observeReadingRestore(context, state, async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(() => recordReadingCancellation([context], state, 'bootstrap_cleanup')).not.toThrow();
});
it('observation state failure never affects the observed work', async () => {
  const receipt = { status: 'settled', exact: true } as const;
  const fail = () => {
    throw new Error('observer unavailable');
  };
  expect(await observeReadingRestore(context, fail, async () => receipt)).toBe(receipt);
  expect(() => recordReadingCancellation([context], fail, 'bootstrap_cleanup')).not.toThrow();
});
it('only records one cancellation for a shared operation, without private context fields', () => {
  const record = vi.spyOn(transport, 'recordConnectionDiagnostic').mockImplementation(() => {});
  const value = { ...context, body: 'private body', draft: 'private draft', title: 'private title' };
  recordReadingCancellation([value, value], () => ({ ...state(), refreshPending: true }), 'bootstrap_cleanup');
  expect(record).toHaveBeenCalledTimes(1);
  expect(record.mock.calls[0]?.[0]).toMatchObject({
    kind: 'reading_restore',
    ...context,
    cancelSource: 'bootstrap_cleanup',
    refreshPending: true,
  });
  expect(JSON.stringify(record.mock.calls)).not.toMatch(/private body|private draft|private title/);
});
