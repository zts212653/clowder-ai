// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  __resetMessageSourceForTest,
  completeMessageSource,
  resumeMessageSource,
  retainMessageSource,
  retireMessageSource,
} from '../entrusted-message-source';
import {
  __resetPendingTeleportForTest,
  consumePendingTeleport,
  peekPendingTeleport,
  setPendingTeleport,
} from '../teleport';

const KEY = 'cat-cafe:f310:pending-source-action:v1';
const coordinate = { threadId: 'source-thread', messageId: 'original-source', blockId: 'original-card' };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  sessionStorage.clear();
  __resetPendingTeleportForTest();
  __resetMessageSourceForTest();
});

it('resumes a legacy source without randomUUID and assigns a fresh request identity', () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  sessionStorage.setItem(KEY, JSON.stringify(coordinate));
  resumeMessageSource(coordinate.threadId);
  expect(peekPendingTeleport(coordinate.threadId)?.sourceAction?.requestId).toMatch(/^[0-9a-f-]{36}$/);
});

it.each([
  'setItem',
  'getItem',
] as const)('focuses the current receipt with %s unavailable, without reviving its predecessor', (method) => {
  const { root, card } = sourceContainer();
  const first = { ...coordinate, sourceAction: retainMessageSource(coordinate) };
  const read = Storage.prototype.getItem;
  const write = Storage.prototype.setItem;
  if (method === 'getItem') {
    vi.spyOn(Storage.prototype, method).mockImplementation(function (this: Storage, key: string) {
      if (this === sessionStorage && key === KEY) throw new DOMException('Denied');
      return read.call(this, key);
    });
  } else {
    vi.spyOn(Storage.prototype, method).mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === sessionStorage && key === KEY) throw new DOMException('Denied');
      write.call(this, key, value);
    });
  }
  const current = { ...coordinate, sourceAction: retainMessageSource(coordinate) };
  retireMessageSource(first);
  completeMessageSource(first, root);
  expect(document.activeElement).not.toBe(card);
  completeMessageSource(current, root);
  expect(document.activeElement).toBe(card);
  expect(card.scrollIntoView).not.toHaveBeenCalled();
});

function sourceContainer() {
  const root = document.createElement('div');
  const message = document.createElement('div');
  message.dataset.messageId = coordinate.messageId;
  const card = document.createElement('button');
  card.dataset.richBlockId = coordinate.blockId;
  card.scrollIntoView = vi.fn();
  message.append(card);
  root.append(message);
  document.body.append(root);
  return { root, card };
}

it.each([
  'retire',
  'complete',
  'focus',
] as const)('remembers %s when its browser boundary fails, without replaying the old request', (terminal) => {
  const { root, card } = sourceContainer();
  const sourceAction = retainMessageSource(coordinate);
  const original = { ...coordinate, sourceAction };
  const fail = () => {
    throw new DOMException('Controlled browser boundary denial');
  };
  if (terminal === 'focus') vi.spyOn(card, 'focus').mockImplementation(fail);
  else vi.spyOn(Storage.prototype, terminal === 'retire' ? 'setItem' : 'removeItem').mockImplementation(fail);
  if (terminal === 'retire') retireMessageSource(original);
  else completeMessageSource(original, root);
  card.blur();
  resumeMessageSource(coordinate.threadId);
  expect(peekPendingTeleport(coordinate.threadId)).toBeNull();
  completeMessageSource(original, root);
  expect(document.activeElement).not.toBe(card);
  vi.restoreAllMocks();
  const retry = retainMessageSource(coordinate);
  expect(retry.requestId).not.toBe(sourceAction.requestId);
  resumeMessageSource(coordinate.threadId);
  expect(peekPendingTeleport(coordinate.threadId)?.sourceAction?.requestId).toBe(retry.requestId);
  completeMessageSource({ ...coordinate, sourceAction: retry }, root);
  expect(document.activeElement).toBe(card);
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

it('never lets an older cancellation or success retire, focus or consume a newer same-source request', () => {
  const { root, card } = sourceContainer();
  const first = { ...coordinate, sourceAction: retainMessageSource(coordinate) };
  const second = { ...coordinate, sourceAction: retainMessageSource(coordinate) };
  retireMessageSource(first);
  completeMessageSource(first, root);
  expect(document.activeElement).not.toBe(card);
  expect(JSON.parse(sessionStorage.getItem(KEY) ?? '{}').requestId).toBe(second.sourceAction.requestId);
  expect(JSON.parse(sessionStorage.getItem(KEY) ?? '{}').retired).not.toBe(true);
  completeMessageSource(second, root);
  expect(document.activeElement).toBe(card);
  expect(sessionStorage.getItem(KEY)).toBeNull();
  expect(card.scrollIntoView).not.toHaveBeenCalled();
});

it('keeps a cancelled source available for a new request without replaying or completing the old request', () => {
  const { root, card } = sourceContainer();
  const sourceAction = retainMessageSource(coordinate);
  const cancelled = { ...coordinate, sourceAction };
  retireMessageSource(cancelled);
  __resetMessageSourceForTest();
  resumeMessageSource(coordinate.threadId);
  expect(peekPendingTeleport(coordinate.threadId)).toBeNull();
  completeMessageSource(cancelled, root);
  expect(document.activeElement).not.toBe(card);
  expect(JSON.parse(sessionStorage.getItem(KEY) ?? '{}')).toMatchObject({
    ...coordinate,
    requestId: sourceAction.requestId,
    retired: true,
  });

  const retry = retainMessageSource(coordinate);
  resumeMessageSource(coordinate.threadId);
  expect(peekPendingTeleport(coordinate.threadId)?.sourceAction?.requestId).toBe(retry.requestId);
  consumePendingTeleport(coordinate.threadId);
  completeMessageSource({ ...coordinate, sourceAction: retry }, root);
  expect(document.activeElement).toBe(card);
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

it('recovers an active stored request into a fresh page and lets only that owner complete it', () => {
  const { root, card } = sourceContainer();
  const sourceAction = retainMessageSource(coordinate);
  __resetMessageSourceForTest();
  resumeMessageSource(coordinate.threadId);
  const pending = peekPendingTeleport(coordinate.threadId);
  expect(pending?.sourceAction?.requestId).toBe(sourceAction.requestId);
  if (!pending) throw new Error('Expected the original stored source request');
  consumePendingTeleport(coordinate.threadId);
  completeMessageSource(pending, root);
  expect(document.activeElement).toBe(card);
  expect(sessionStorage.getItem(KEY)).toBeNull();
});

it('focuses only the source inside the receipt owner viewport when two panes share an id', () => {
  const other = sourceContainer();
  const current = sourceContainer();
  const sourceAction = retainMessageSource(coordinate);
  completeMessageSource({ ...coordinate, sourceAction }, current.root);
  expect(document.activeElement).toBe(current.card);
  expect(other.card.scrollIntoView).not.toHaveBeenCalled();
  expect(current.card.scrollIntoView).not.toHaveBeenCalled();
});

it('replays a legacy coordinate once without replacing an already pending reading intent', () => {
  sessionStorage.setItem(KEY, JSON.stringify(coordinate));
  resumeMessageSource('another-thread');
  expect(peekPendingTeleport(coordinate.threadId)).toBeNull();
  resumeMessageSource(coordinate.threadId);
  expect(peekPendingTeleport(coordinate.threadId)).toMatchObject({
    threadId: coordinate.threadId,
    messageId: coordinate.messageId,
    sourceAction: { blockId: coordinate.blockId },
  });
  const pending = { threadId: coordinate.threadId, messageId: 'new-user-intent' };
  setPendingTeleport(pending);
  resumeMessageSource(coordinate.threadId);
  expect(peekPendingTeleport(coordinate.threadId)).toBe(pending);
});
