import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { RecoveryBindingSession } from '@/components/useRecoveryBindingSync';
import { apiFetch } from '@/utils/api-client';
import { FakeHost, gate, jsonResponse, REVIEW, STARS } from './cloud-route-test-fixtures';

/** A recovery card identity's binding session on its own: what an ended session may still do. */

const mockApiFetch = vi.mocked(apiFetch);
let host: FakeHost;
let shown: Array<string | null>;
let session: RecoveryBindingSession;

beforeEach(() => {
  host = new FakeHost();
  host.bindings = { 'gpt-pro': STARS.chatUrl };
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation(
    async (path, init, options) => host.handle(path, init, options) ?? jsonResponse({}, 404),
  );
  shown = [];
  session = new RecoveryBindingSession(host.threadId, 'gpt-pro', (conversationId) => shown.push(conversationId));
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('reads the binding when another surface announces a change, and shows it', async () => {
  host.bindings['gpt-pro'] = REVIEW.chatUrl;
  session.heardChange();
  await settle();
  expect(shown).toEqual([REVIEW.conversationId]);
});

it('once ended, hears no change and reads nothing', async () => {
  session.end();
  session.heardChange();
  await settle();
  expect(host.bindingReads()).toHaveLength(0);
  expect(shown).toEqual([]);
});

it('once ended, a write it began is neither read back nor shown', async () => {
  session.beginWrite();
  session.end();
  expect(session.writeLanded(REVIEW.conversationId)).toBe(false);
  session.operationEnded();
  await settle();
  expect(host.bindingReads()).toHaveLength(0);
  expect(shown).toEqual([]);
});

it('once ended, an answer to a write is never shown, even with no write of its own on record', () => {
  session.end();
  expect(session.writeLanded(REVIEW.conversationId)).toBe(false);
});

it('once ended, an operation it began that never landed reads nothing', async () => {
  session.beginWrite();
  session.end();
  session.operationEnded();
  await settle();
  expect(host.bindingReads()).toHaveLength(0);
});

it('a read still in flight when the session ends shows nothing', async () => {
  const read = gate();
  host.readPlan = [{ gate: read.promise }];
  session.heardChange();
  session.end();
  read.open();
  await settle();
  expect(host.bindingReads()).toHaveLength(1);
  expect(shown).toEqual([]);
});

it('reopened, it works again (a remount of the same identity)', async () => {
  session.end();
  session.open();
  session.heardChange();
  await settle();
  expect(shown).toEqual([STARS.conversationId]);
});
