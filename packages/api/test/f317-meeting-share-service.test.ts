import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  F195CaptureObservation,
  F317LiveCallObservation,
} from '../src/domains/concierge/meeting/f317-meeting-admission.js';
import {
  type F317MeetingSharePorts,
  F317MeetingShareService,
} from '../src/domains/concierge/meeting/f317-meeting-share-service.js';

function fixture() {
  let call: F317LiveCallObservation | null = {
    userId: 'owner-1',
    threadId: 'live-thread',
    catId: 'codex6-sol',
    callId: 'call-1',
    generation: 1,
    state: 'talking',
  };
  let capture: F195CaptureObservation | null = {
    running: true,
    paused: false,
    threadId: 'meeting-thread',
    meetingId: 'mtg-1',
    startedAt: 100,
    inputs: [{ id: 'app-1', source: 'app', label: 'Local test app', state: 'running' }],
  };
  let owner = 'owner-1';
  const attached: string[] = [];
  const detached: string[] = [];
  let liveGrantId: string | null = null;
  let verifyAttached: (() => Promise<boolean>) | undefined;
  let failAttach = false;
  let attachBarrier: Promise<void> | null = null;
  const ports = {
    observeCall: async () => call,
    observeCapture: async () => capture,
    ownerOfThread: async () => owner,
    attach: async (grant, verify) => {
      if (failAttach) throw new Error('host_unavailable');
      attached.push(grant.grantId);
      liveGrantId = grant.grantId;
      verifyAttached = verify;
      if (attachBarrier) await attachBarrier;
    },
    detach: async (grant) => {
      detached.push(grant.grantId);
      if (liveGrantId === grant.grantId) liveGrantId = null;
    },
    isAttached: (grant) => liveGrantId === grant.grantId,
  } satisfies F317MeetingSharePorts;
  const service = new F317MeetingShareService(ports);
  return {
    service,
    attached,
    detached,
    loseAttachment: () => {
      liveGrantId = null;
    },
    verifyAttached: () => verifyAttached,
    setCall: (next: F317LiveCallObservation | null) => {
      call = next;
    },
    setCapture: (next: F195CaptureObservation | null) => {
      capture = next;
    },
    setOwner: (next: string) => {
      owner = next;
    },
    failAttach: () => {
      failAttach = true;
    },
    holdAttach: () => {
      let release = () => {};
      attachBarrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

test('preview gives exact coordinates but never attaches or grants on its own', async () => {
  const f = fixture();
  const preview = await f.service.preview('owner-1');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') return;
  assert.deepEqual(preview.intent, {
    callId: 'call-1',
    generation: 1,
    captureThreadId: 'meeting-thread',
    meetingId: 'mtg-1',
    captureStartedAt: 100,
    inputId: 'app-1',
    inputLabel: 'Local test app',
  });
  assert.equal(preview.catId, 'codex6-sol');
  assert.equal(preview.inputLabel, 'Local test app');
  assert.equal(preview.sharing, false);
  assert.equal(f.attached.length, 0);
});

test('Host feed loss revokes a stale share even while F195 capture remains running', async () => {
  const f = fixture();
  const preview = await f.service.preview('owner-1');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') return;
  const grant = await f.service.share('owner-1', preview.intent);
  f.loseAttachment();
  const afterLoss = await f.service.preview('owner-1');
  assert.equal(afterLoss.kind, 'available');
  if (afterLoss.kind === 'available') assert.equal(afterLoss.sharing, false);
  assert.equal(grant.signal.aborted, true);
  assert.equal(f.service.current(), null);
  assert.deepEqual(f.detached, [grant.grantId]);
  assert.equal(await f.verifyAttached()?.(), false);
});

test('final provider verification sees Host feed loss without waiting for UI polling', async () => {
  const f = fixture();
  const preview = await f.service.preview('owner-1');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') return;
  const grant = await f.service.share('owner-1', preview.intent);
  f.loseAttachment();
  assert.equal(await f.verifyAttached()?.(), false);
  assert.equal(grant.signal.aborted, true);
  assert.equal(f.service.current(), null);
});

test('a stale duplicate POST cannot report success after Host attachment loss', async () => {
  const f = fixture();
  const preview = await f.service.preview('owner-1');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') return;
  const grant = await f.service.share('owner-1', preview.intent);
  f.loseAttachment();
  await assert.rejects(f.service.share('owner-1', preview.intent), /meeting_share_not_admitted/);
  assert.equal(grant.signal.aborted, true);
  assert.equal(f.service.current(), null);
  assert.equal(f.attached.length, 1);
});

test('Host feed loss during attach never confirms sharing', async () => {
  const f = fixture();
  const preview = await f.service.preview('owner-1');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') return;
  const release = f.holdAttach();
  const sharing = f.service.share('owner-1', preview.intent);
  for (let attempt = 0; attempt < 10 && f.attached.length === 0; attempt++) await Promise.resolve();
  assert.equal(f.attached.length, 1);
  f.loseAttachment();
  release();
  await assert.rejects(sharing, /meeting_share_not_admitted/);
  assert.equal(f.service.current(), null);
});

test('explicit owner share attaches once; stop revokes before a late provider write', async () => {
  const f = fixture();
  const preview = await f.service.preview('owner-1');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') return;
  const grant = await f.service.share('owner-1', preview.intent);
  assert.equal(f.attached.length, 1);
  assert.equal(await f.verifyAttached()?.(), true);
  const again = await f.service.share('owner-1', preview.intent);
  assert.equal(again, grant);
  assert.equal(f.attached.length, 1);
  f.setCapture(null);
  assert.equal(await f.verifyAttached()?.(), false);
  assert.equal(grant.signal.aborted, true);
  assert.equal(f.service.current(), null);
});

test('coordinates and owner are rechecked at click; stale preview and foreign owner cannot share', async () => {
  const f = fixture();
  const preview = await f.service.preview('owner-1');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') return;
  f.setCall({
    userId: 'owner-1',
    threadId: 'live-thread',
    catId: 'codex6-sol',
    callId: 'call-1',
    generation: 2,
    state: 'talking',
  });
  await assert.rejects(f.service.share('owner-1', preview.intent), /meeting_share_not_admitted/);
  f.setCall({
    userId: 'owner-1',
    threadId: 'live-thread',
    catId: 'codex6-sol',
    callId: 'call-1',
    generation: 1,
    state: 'talking',
  });
  f.setOwner('other-user');
  await assert.rejects(f.service.share('owner-1', preview.intent), /meeting_share_not_admitted/);
  assert.equal(f.attached.length, 0);
});

test('a preview for one App cannot authorize a different App or changed display label', async () => {
  for (const input of [
    { id: 'app-2', source: 'app' as const, label: 'Different App', state: 'running' },
    { id: 'app-1', source: 'app' as const, label: 'Renamed App', state: 'running' },
  ]) {
    const f = fixture();
    const preview = await f.service.preview('owner-1');
    assert.equal(preview.kind, 'available');
    if (preview.kind !== 'available') return;
    f.setCapture({
      running: true,
      paused: false,
      threadId: 'meeting-thread',
      meetingId: 'mtg-1',
      startedAt: 100,
      inputs: [input],
    });
    await assert.rejects(f.service.share('owner-1', preview.intent), /meeting_share_not_admitted/);
    assert.equal(f.attached.length, 0);
    assert.equal(f.service.current(), null);
  }
});

test('failed Host attach leaves no grant; explicit revoke aborts and detaches', async () => {
  const f = fixture();
  const preview = await f.service.preview('owner-1');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') return;
  f.failAttach();
  await assert.rejects(f.service.share('owner-1', preview.intent), /host_unavailable/);
  assert.equal(f.service.current(), null);
  const next = fixture();
  const available = await next.service.preview('owner-1');
  assert.equal(available.kind, 'available');
  if (available.kind !== 'available') return;
  const grant = await next.service.share('owner-1', available.intent);
  await next.service.revoke('owner-1');
  assert.equal(grant.signal.aborted, true);
  assert.deepEqual(next.detached, [grant.grantId]);
  assert.equal(await next.verifyAttached()?.(), false);
});

test('two simultaneous owner clicks attach one grant once', async () => {
  const f = fixture();
  const preview = await f.service.preview('owner-1');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') return;
  const release = f.holdAttach();
  const first = f.service.share('owner-1', preview.intent);
  const second = f.service.share('owner-1', preview.intent);
  for (let attempt = 0; attempt < 10 && f.attached.length === 0; attempt++) await Promise.resolve();
  const pending = await f.service.preview('owner-1');
  assert.equal(pending.kind, 'available');
  if (pending.kind === 'available')
    assert.equal(pending.sharing, false, 'pending Host attach is not a confirmed share');
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one, two);
  assert.equal(f.attached.length, 1);
});
