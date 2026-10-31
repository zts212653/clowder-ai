import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { createLiveMeetingRequestAuthority } from '../src/domains/concierge/meeting/live-meeting-request-authority.js';

async function fixture() {
  const threads = new ThreadStore(),
    messages = new MessageStore();
  const thread = await threads.create('owner');
  const principal = {
    kind: 'invocation' as const,
    invocationId: 'inv-1',
    userId: 'owner',
    threadId: thread.id,
    catId: 'codex61-sol' as CatId,
  };
  const scope = { ...principal, callId: 'call-1', generation: 1 };
  let controller = new AbortController(),
    epoch = 0,
    exposed = true,
    available = true;
  const source = messages.append({
    from: { kind: 'user', userId: 'owner' },
    userId: 'owner',
    threadId: thread.id,
    content: '开始听 Chrome',
    mentions: [],
    timestamp: Date.now(),
    extra: { liveCompanion: { callId: 'call-1', modality: 'typed', role: 'user', clientMessageId: 'input-1' } },
  });
  const voice = {
    currentSignal: () => controller.signal,
    currentEpoch: () => epoch,
    availableForAction: () => available,
    inspectUtterance: async () => ({ text: '不要开始听 Chrome', messages: [source] }),
  };
  const call = {
    householdToolsEnabled: true,
    contextScope: () => scope,
    acceptsInput: () => true,
    hasCurrentCompanion: async () => true,
    exposureReason: () => (exposed ? ('same_live_call_exposure' as const) : null),
    boundaryContexts: { ownerVoice: voice },
  };
  const authorize = createLiveMeetingRequestAuthority({
    ownerUserId: 'owner',
    threads,
    messages,
    isCurrentThread: async () => true,
    sessions: { get: () => call, observeCall: async () => ({ ...scope, state: 'talking' }) },
  });
  return {
    principal,
    source,
    messages,
    authorize,
    call,
    setExposed: (v: boolean) => {
      exposed = v;
    },
    interrupt: () => {
      controller.abort();
      controller = new AbortController();
      epoch++;
    },
    setAvailable: (v: boolean) => {
      available = v;
    },
  };
}

test('reads Host owner text; source exposure and owner/current call are mandatory', async () => {
  const f = await fixture();
  assert.equal((await f.authorize(f.principal, f.source.id)).request?.text, '开始听 Chrome');
  await assert.rejects(f.authorize({ ...f.principal, userId: 'stranger' }, f.source.id), /owner_required/);
  f.setExposed(false);
  await assert.rejects(f.authorize(f.principal, f.source.id), /request_unavailable/);
});

test('later direct owner input supersedes old consent; user speaking cannot admit a request', async () => {
  const f = await fixture();
  f.messages.append({
    from: { kind: 'user', userId: 'owner' },
    userId: 'owner',
    threadId: f.principal.threadId,
    content: '别录音',
    mentions: [],
    timestamp: Date.now(),
  });
  await assert.rejects(f.authorize(f.principal, f.source.id), /request_unavailable/);
  f.setAvailable(false);
  await assert.rejects(f.authorize(f.principal, f.source.id), /request_unavailable/);
});

test('voice uses whole utterance including preceding negation, rather than last segment', async () => {
  const f = await fixture();
  assert.ok(f.source.extra);
  f.source.extra.liveCompanion = { callId: 'call-1', modality: 'voice', role: 'user' };
  assert.equal((await f.authorize(f.principal, f.source.id)).request?.text, '不要开始听 Chrome');
});

test('an interruption during a voice read invalidates admission even if the old message remains latest', async () => {
  const f = await fixture();
  assert.ok(f.source.extra);
  f.source.extra.liveCompanion = { callId: 'call-1', modality: 'voice', role: 'user' };
  f.call.boundaryContexts.ownerVoice.inspectUtterance = async () => {
    f.interrupt();
    return { text: '开始听 Chrome', messages: [f.source] };
  };
  await assert.rejects(f.authorize(f.principal, f.source.id), /current_live_required/);
});

test('ordinary CLI invocation cannot borrow the owner Live call through a forged thread/cat', async () => {
  const f = await fixture();
  await assert.rejects(
    f.authorize({ ...f.principal, invocationId: 'wrong-invocation' }, f.source.id),
    /current_live_required/,
  );
});

test('explicit per-call meeting request is independent of household read permission', async () => {
  const f = await fixture();
  f.call.householdToolsEnabled = false;
  assert.equal((await f.authorize(f.principal, f.source.id)).request?.text, '开始听 Chrome');
});
