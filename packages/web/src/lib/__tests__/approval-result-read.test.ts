import { describe, expect, it, vi } from 'vitest';
import { createApprovalResultRead } from '../approval-result-read';

const key = { owner: 'owner', producer: 'F128', proposalId: 'same' };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
describe('shared approval result evidence', () => {
  it('N consumers and unmount/remount share one physical request without clearing a completed result', async () => {
    const read = createApprovalResultRead(),
      pending = deferred<{ status: string }>();
    const load = vi.fn(() => pending.promise);
    const promises = Array.from({ length: 12 }, () => read.read(key, 'native', load));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    pending.resolve({ status: 'pending' });
    await Promise.all(promises);
    const remove = read.subscribe(key, () => {});
    remove();
    expect(await read.read(key, 'native', load)).toEqual({ status: 'pending' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(read.snapshot(key, 'native').reading).toBe(false);
  });
  it('already observed terminal evidence needs zero requests', async () => {
    const read = createApprovalResultRead(),
      load = vi.fn();
    read.seed(key, 'native', { status: 'approved', createdThreadId: 'child' });
    expect(await read.read(key, 'native', load)).toEqual({ status: 'approved', createdThreadId: 'child' });
    expect(load).not.toHaveBeenCalled();
  });
  it('manual/event refresh keeps the last value and failure keeps its observation time', async () => {
    const read = createApprovalResultRead();
    read.seed(key, 'native', { status: 'pending' });
    const before = read.snapshot(key, 'native'),
      pending = deferred<{ status: string }>();
    const refresh = read.read(key, 'native', () => pending.promise, true);
    expect(read.snapshot(key, 'native').value).toBe(before.value);
    pending.resolve({ status: 'approved' });
    await refresh;
    const updated = read.snapshot(key, 'native');
    await expect(
      read.read(
        key,
        'native',
        async () => {
          throw new Error('offline');
        },
        true,
      ),
    ).rejects.toThrow('offline');
    expect(read.snapshot(key, 'native')).toMatchObject({
      value: updated.value,
      observedAt: updated.observedAt,
      reading: false,
      failed: true,
    });
  });
  it('clearing an owner aborts and fences late responses; another owner never sees the old result', async () => {
    const read = createApprovalResultRead(),
      pending = deferred<string>();
    const old = read.read(key, 'native', () => pending.promise);
    read.clearOwner('owner');
    pending.resolve('private');
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    expect(read.snapshot(key, 'native').value).toBeUndefined();
    expect(read.snapshot({ ...key, owner: 'other' }, 'native').value).toBeUndefined();
  });
});

it('new facts withdraw every derived projection, while admission stores no result copy', () => {
  const read = createApprovalResultRead();
  read.seedFacts(key, { settled: { resolution: 'accepted', effect: 'unknown' } });
  for (const part of ['effect', 'thread-binding', 'original:card', 'receipt:legacy']) read.seed(key, part, null);
  read.seed(key, 'receipt-admission:stamp', true);
  const version = read.factsVersion(key);
  read.seedFacts(key, { settled: { resolution: 'accepted', effect: 'succeeded' }, 'verified-thread': 'child' });
  expect(read.factsVersion(key)).toBe(version + 1);
  for (const part of ['effect', 'thread-binding', 'original:card', 'receipt:legacy'])
    expect(read.isCurrent(key, part)).toBe(false);
  expect(read.isCurrent(key, 'receipt-admission:stamp')).toBe(true);
  expect(read.isCurrent(key, 'verified-thread')).toBe(true);
});
it('a late projection re-derives from the new fact version instead of installing its captured old result', async () => {
  const read = createApprovalResultRead(),
    pending = deferred<void>();
  read.seedFacts(key, { settled: 'unknown' });
  let calls = 0;
  const result = read.read(key, 'projection', async () => {
    const value = read.snapshot<string>(key, 'settled').value;
    if (++calls === 1) await pending.promise;
    return value;
  });
  await Promise.resolve();
  read.seedFacts(key, { settled: 'succeeded' });
  pending.resolve();
  expect(await result).toBe('succeeded');
  expect(read.snapshot(key, 'projection').value).toBe('succeeded');
});
it('an older source window cannot replace a newer result, even when the newest window repeated the same content', () => {
  const read = createApprovalResultRead();
  const first = read.beginObservation(),
    older = read.beginObservation(),
    newer = read.beginObservation();
  read.seedFacts(key, { settled: 'succeeded' }, first);
  read.seedFacts(key, { settled: 'succeeded' }, newer);
  expect(read.seedFacts(key, { settled: 'unknown' }, older)).toBe(false);
  expect(read.snapshot(key, 'settled').value).toBe('succeeded');
});
