// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { sendHeldDraft } from '../PdlAppHost';

beforeEach(() => sessionStorage.clear());

function run(send: (key: string) => Promise<unknown>, signature = 'A') {
  const hold = vi.fn();
  const clear = vi.fn();
  return { done: sendHeldDraft({ threadId: 't1', signature, keyed: true, send, hold, clear }), hold, clear };
}

it('leaves the draft where it was when the send is not taken, holding the input only meanwhile', async () => {
  const r = run(async () => false);
  expect(await r.done).toBe(false);
  expect(r.clear).not.toHaveBeenCalled();
  expect(r.hold.mock.calls).toEqual([[true], [false]]);
});

it('keeps the draft and releases the input when the send fails outright', async () => {
  const r = run(async () => {
    throw new Error('offline');
  });
  await expect(r.done).rejects.toThrow('offline');
  expect(r.clear).not.toHaveBeenCalled();
  expect(r.hold.mock.calls).toEqual([[true], [false]]);
});

it('sends the same content again under the same attempt key, and changed content under a new one', async () => {
  const keys: string[] = [];
  const send = async (key: string) => {
    keys.push(key);
    return false;
  };
  await run(send).done;
  await run(send).done;
  await run(send, 'B').done;
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
});

it('clears only once the server takes the send, and the next message gets its own key', async () => {
  const keys: string[] = [];
  const send = async (key: string) => {
    keys.push(key);
    return true;
  };
  const r = run(send);
  expect(await r.done).toBe(true);
  expect(r.clear).toHaveBeenCalledTimes(1);
  await run(send).done;
  expect(keys[1]).not.toBe(keys[0]);
});
