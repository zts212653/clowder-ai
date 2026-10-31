import { expect, it } from 'vitest';
import { acknowledgeHumanSend, prepareHumanSend } from '../human-send-custody.js';

it('recovers the same Human event after response loss and reload, regardless of input property order', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const payload = {
    body: 'Help me',
    location: { channelId: 'a' },
    recipient: { kind: 'channel' as const },
    collectiveId: 'col_aaaaaaaa',
    serviceInstanceId: 'svc_aaaaaaaa',
  };
  const first = prepareHumanSend(storage, 'world-a', payload, () => 'one');
  const second = prepareHumanSend(storage, 'world-a', { ...payload, location: { channelId: 'a' } }, () => 'two');
  expect(second.clientEventId).toBe(first.clientEventId);
  expect(prepareHumanSend(storage, 'world-b', payload, () => 'three').clientEventId).toBe('three');
  acknowledgeHumanSend(storage, 'world-a', first.clientEventId);
  expect(prepareHumanSend(storage, 'world-a', payload, () => 'four').clientEventId).toBe('four');
});
