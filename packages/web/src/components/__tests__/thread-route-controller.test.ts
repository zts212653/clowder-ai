import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import type { RouteOperation } from '@/components/CloudConversationRouteNotice';
import type { ThreadCloudRouteRead } from '@/components/thread-cloud-route';
import { ThreadRouteController } from '@/components/thread-route-controller';
import { apiFetch } from '@/utils/api-client';
import { FakeHost, gate, jsonResponse, REVIEW, STARS, UNTITLED } from './cloud-route-test-fixtures';

/** The controller without React: what it shows, in order, as reads and writes come back. */

const mockApiFetch = vi.mocked(apiFetch);
let host: FakeHost;

beforeEach(() => {
  host = new FakeHost();
  host.bindings = { 'gpt-pro': STARS.chatUrl };
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation(
    async (path, init, options) => host.handle(path, init, options) ?? jsonResponse({}, 404),
  );
});
afterEach(() => vi.restoreAllMocks());

function controller() {
  const shown: { read: ThreadCloudRouteRead; operation: RouteOperation; landed: string[] } = {
    read: { kind: 'loading' },
    operation: { kind: 'idle' },
    landed: [],
  };
  const route = new ThreadRouteController({
    threadId: host.threadId,
    source: 'panel',
    setRead: (read) => {
      shown.read = read;
    },
    setBusy: () => {},
    setOperation: (update) => {
      shown.operation = typeof update === 'function' ? update(shown.operation) : update;
    },
    onLanded: (action) => shown.landed.push(action),
  });
  return { route, shown };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const conversationOf = (read: ThreadCloudRouteRead) =>
  read.kind === 'ready' && read.binding && read.binding !== 'invalid' ? read.binding.conversationId : read.kind;

it('sends one write at a time, however often it is asked', async () => {
  const { route, shown } = controller();
  route.open();
  await settle();
  const answer = gate();
  host.patchPlan = [{ gate: answer.promise }];

  route.write('change', REVIEW);
  route.write('change', UNTITLED);
  route.write('disconnect', null);
  answer.open();
  await settle();

  expect(host.patches()).toEqual([{ catId: 'gpt-pro', chatUrl: REVIEW.chatUrl }]);
  expect(conversationOf(shown.read)).toBe(REVIEW.conversationId);
  expect(shown.landed).toEqual(['change']);
});

it('never lets a read that began before a write paint over it', async () => {
  const { route, shown } = controller();
  route.open();
  await settle();
  const lateRead = gate();
  host.readPlan = [{ gate: lateRead.promise }];

  route.heardChange(); // a read of the bindings as they are now: STARS
  route.write('change', REVIEW);
  await settle();
  expect(conversationOf(shown.read)).toBe(REVIEW.conversationId);

  lateRead.open();
  await settle();
  expect(conversationOf(shown.read)).toBe(REVIEW.conversationId);
});

it('writes nothing while a write of unknown outcome is unsettled', async () => {
  const { route, shown } = controller();
  route.open();
  await settle();
  host.patchPlan = ['lost'];
  host.readPlan = ['fail'];

  route.write('change', REVIEW);
  await settle();
  expect(shown.operation).toEqual({ kind: 'unknown', action: 'change' });

  route.write('change', UNTITLED);
  route.write('disconnect', null);
  await settle();
  expect(host.patches()).toHaveLength(1);

  route.reread();
  await settle();
  expect(shown.operation).toEqual({ kind: 'idle' });
  expect(conversationOf(shown.read)).toBe(REVIEW.conversationId);
  expect(shown.landed).toEqual(['change']);
});

it('stops showing anything once closed', async () => {
  const { route, shown } = controller();
  route.open();
  await settle();
  const answer = gate();
  host.patchPlan = [{ gate: answer.promise }];

  route.write('change', REVIEW);
  route.close();
  answer.open();
  await settle();

  expect(conversationOf(shown.read)).toBe(STARS.conversationId);
  expect(shown.landed).toEqual([]);
});
