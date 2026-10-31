import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerClient } from '../src/domains/cats/services/agents/providers/CodexAppServerClient.ts';
import { LiveContextGate } from '../src/domains/concierge/live/host/live-controlled-context.ts';
import { LivePageResultHost } from '../src/domains/concierge/live/host/page-action/live-page-result-host.ts';
import {
  persistPageOutcome,
  settlePageOutcome,
} from '../src/domains/concierge/live/host/page-action/owner-page-action-support.ts';
import { wireFixture } from './helpers/f317-live-wire-fixture.mjs';

const scope = {
  userId: 'owner',
  threadId: 'home',
  catId: 'codex61-sol',
  callId: 'call',
  invocationId: 'invocation',
  generation: 1,
};
function hostFixture() {
  let open = true,
    household = true,
    wakes = 0,
    beforeWrite = async () => {};
  const writes = [];
  const gate = new LiveContextGate({
    binding: scope,
    acceptsInput: () => open,
    matchesInvocation: (q) => q.invocationId === scope.invocationId,
    householdToolsEnabled: () => household,
    verifyCompanion: async () => true,
    run: (operation) => operation(),
    client: () => ({
      request: async () => ({}),
      submitText: async () => 'unused',
      submitContextAtBoundary: async (text, refs, kind, signal, authorize) => {
        await beforeWrite();
        if (signal.aborted || !(await authorize())) throw new Error('source changed at native write');
        writes.push({ text, refs, kind });
        return 'active-turn';
      },
    }),
  });
  const host = new LivePageResultHost(
    gate,
    () => wakes++,
    () => open,
  );
  return {
    gate,
    host,
    writes,
    wakes: () => wakes,
    beforeWrite: (f) => {
      beforeWrite = f;
    },
    disable: () => {
      household = false;
    },
    stop: () => {
      open = false;
      host.close();
      gate.close('stopped');
    },
  };
}
const notice = (current = () => true) => ({
  scope,
  text: '{"status":"applied","after":"带伞"}',
  sourceRefs: ['home#request', 'home#durable-receipt'],
  isCurrent: current,
});

test('a durable page outcome retains the actual stored message source for Live delivery', async () => {
  let storedRef;
  const preview = { id: 'preview', scope: { threadId: 'home' }, requestMessageId: 'request', plan: {} };
  const outcome = { status: 'applied', forward: { status: 'applied', before: '', after: '带伞' } };
  const result = await persistPageOutcome(
    { recordResult: async () => 'durable-receipt-message' },
    preview,
    outcome,
    (id) => {
      storedRef = id;
    },
  );
  assert.equal(result.receiptPersistence, 'stored');
  assert.equal(storedRef, 'durable-receipt-message');
});

test('a durable owner receipt wakes the same call and is handed over as data, without a new grant', async () => {
  const f = hostFixture();
  const entry = {
    call: {
      acceptsInput: () => true,
      householdToolsEnabled: true,
      boundaryContexts: { queuePageResult: (n) => f.host.queue(n) },
    },
  };
  const preview = { id: 'preview', scope, requestMessageId: 'request', plan: { selection: {} } };
  const outcome = { status: 'applied', forward: { status: 'applied', before: '', after: '带伞' } };
  await settlePageOutcome({ recordResult: async () => 'durable-receipt' }, entry, preview, outcome);
  assert.equal(f.wakes(), 1);
  assert.equal(await f.host.atBoundary(), 'accepted');
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].kind, 'page_action_result');
  assert.deepEqual(f.writes[0].refs, ['home#request', 'home#durable-receipt']);
  assert.match(f.writes[0].text, /not a new action grant/);
  const envelope = JSON.parse(f.writes[0].text.split('\n').at(-1));
  assert.equal(JSON.parse(envelope.text).resultRequestMessageId, 'request');
  assert.equal(f.host.hasPendingWake(), false);
});

test('current-page receipts cannot leak Host readbacks or preview capabilities through history or native Live context', async () => {
  const f = hostFixture();
  const entry = {
    call: {
      acceptsInput: () => true,
      householdToolsEnabled: true,
      boundaryContexts: { queuePageResult: (notice) => f.host.queue(notice) },
    },
  };
  const preview = {
    id: 'owner-consent-capability',
    scope,
    requestMessageId: 'request',
    profile: { spec: { currentControls: true } },
    plan: {
      selection: {
        requestId: 'selection',
        providerRequestId: null,
        requestedModel: 'jev-latest',
        servedModel: 'jev-stub',
        inputSha256: 'hash',
        candidates: [{ id: 'control-0', label: 'Save', operation: 'click' }],
        choice: { kind: 'act', targetId: 'control-0', operation: 'click' },
        confidence: 1,
        elapsedMs: 0,
      },
    },
  };
  const outcome = {
    status: 'unknown',
    forward: {
      status: 'unknown',
      before: 'private-original-value',
      after: 'private-page-result',
      reason: 'effect_unverified',
    },
  };
  let persisted;
  const result = await settlePageOutcome(
    {
      recordResult: async (input) => {
        persisted = input;
        return 'durable-receipt';
      },
    },
    entry,
    preview,
    outcome,
  );
  assert.equal(await f.host.atBoundary(), 'accepted');
  assert.equal(f.writes.length, 1);
  for (const text of [persisted.body, f.writes[0].text]) {
    assert.ok(!text.includes('private-original-value'));
    assert.ok(!text.includes('private-page-result'));
    assert.ok(!text.includes('owner-consent-capability'));
    assert.ok(!text.includes('previewId'));
    assert.match(text, /effect_unverified/);
  }
  assert.equal(JSON.parse(persisted.body).outcome.status, 'unknown');
  assert.equal(entry.lastReceipt.outcome.forward.before, 'private-original-value', 'owner view retains real readback');
  assert.equal(result.forward.after, 'private-page-result', 'owner confirm response retains observed data');
  assert.equal(result.receiptPersistence, 'stored');
});

test('superseded receipt, foreign call and stopped or household-off call cannot submit result context', async () => {
  const stale = hostFixture();
  let current = true;
  stale.host.queue(notice(() => current));
  stale.beforeWrite(async () => {
    current = false;
  });
  assert.equal(await stale.host.atBoundary(), 'cancelled');
  assert.equal(stale.writes.length, 0);
  const foreign = hostFixture();
  foreign.host.queue({ ...notice(), scope: { ...scope, callId: 'foreign' } });
  await foreign.host.atBoundary();
  assert.equal(foreign.writes.length, 0);
  const disabled = hostFixture();
  disabled.disable();
  disabled.host.queue(notice());
  await disabled.host.atBoundary();
  assert.equal(disabled.writes.length, 0);
  const stopped = hostFixture();
  stopped.host.queue(notice());
  stopped.stop();
  assert.equal(await stopped.host.atBoundary(), 'idle');
  assert.equal(stopped.writes.length, 0);
});

test('failed receipt storage supplies no source or Live result wake; late old storage cannot replace a newer outcome', async () => {
  const f = hostFixture();
  const entry = {
    call: {
      acceptsInput: () => true,
      householdToolsEnabled: true,
      boundaryContexts: { queuePageResult: (n) => f.host.queue(n) },
    },
  };
  const preview = { id: 'old', scope, requestMessageId: 'old-request', plan: { selection: {} } };
  const outcome = { status: 'applied', forward: { status: 'applied', after: 'old' } };
  const failed = await settlePageOutcome(
    {
      recordResult: async () => {
        throw new Error('store unavailable');
      },
    },
    entry,
    preview,
    outcome,
  );
  assert.equal(failed.receiptPersistence, 'unconfirmed');
  assert.equal(f.wakes(), 0);
  const newer = {
    previewId: 'new',
    requestMessageId: 'new-request',
    observedAtMs: Date.now(),
    outcome: { status: 'applied', forward: { after: 'new' } },
  };
  entry.preview = { id: 'new' };
  entry.lastReceipt = newer;
  await settlePageOutcome({ recordResult: async () => 'old-receipt' }, entry, preview, outcome);
  assert.equal(entry.lastReceipt, newer);
  assert.equal(f.wakes(), 0);
});

test('a persisted page-result wake steers the active turn before its old final answer', { timeout: 2000 }, async () => {
  const f = wireFixture({ holdFirstTurn: true });
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  let port;
  let pending = true;
  const client = new CodexAppServerClient({ wire: f.wire });
  try {
    for await (const _event of client.run({
      thread: { kind: 'start' },
      prompt: { kind: 'frozen', prompt: 'synthetic page call' },
      prepareLiveRequest: (input) => ({
        v: 1,
        message: {
          body: 'The Host attached source-linked context at its original trust level. Continue this call; this is not a new user request.',
        },
        nativeInstructions: [{ body: input.text, injectionDecision: 'app_server_live_context' }],
        runtime: {},
        tools: {},
        providerNativeVisibility: 'unknown',
      }),
      live: {
        finished,
        ready: async (_thread, native) => {
          port = native;
          native.wakeBoundary();
          setTimeout(() => f.push(f.completed('first')), 30);
        },
        observe: async (message) => {
          if (message.method === 'turn/completed' && !pending) finish();
        },
        hasPendingInboxWake: () => pending,
        hasPendingPageResultWake: () => pending,
        onSafeBoundary: async () => {
          if (!pending) return;
          await port.submitContextAtBoundary(
            'Host receipt: applied; original request home#request; observed value 带伞',
            ['home#receipt'],
            'page_action_result',
            new AbortController().signal,
            async () => true,
          );
          pending = false;
          f.push(f.completed('first'));
        },
      },
    })) {
      /* Consume the real notification-loop implementation. */
    }
    const steer = f.writes.find((row) => row.method === 'turn/steer');
    assert.ok(steer, 'owner result must reach the already-running turn, not a later idle turn');
    assert.equal(steer.params.expectedTurnId, 'first');
    assert.equal(steer.params.additionalContext['cat-cafe.live-context'].kind, 'application');
    assert.match(steer.params.additionalContext['cat-cafe.live-context'].value, /applied/);
  } finally {
    await f.wire.close();
  }
});
