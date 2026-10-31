import assert from 'node:assert/strict';
import { F317MeetingShareService } from '../../src/domains/concierge/meeting/f317-meeting-share-service.js';
import { LiveMeetingControl } from '../../src/domains/concierge/meeting/live-meeting-control.js';
import type {
  LiveMeetingAudioPort,
  LiveMeetingRequest,
  MeetingCapture,
} from '../../src/domains/concierge/meeting/live-meeting-control-contract.js';

export function createMeetingControlFixture(
  hooks: {
    beforeStart?: (input: Parameters<LiveMeetingAudioPort['start']>[0]) => Promise<void>;
    beforeAttach?: () => Promise<void>;
    beforeShareCapture?: () => Promise<void>;
    observeStatus?: (capture: MeetingCapture) => MeetingCapture | null;
    beforeStop?: () => Promise<void>;
    stopFails?: boolean;
    detachFails?: boolean;
  } = {},
) {
  const principal = {
    kind: 'invocation' as const,
    invocationId: 'invoke-1',
    userId: 'owner',
    threadId: 'thread-1',
    catId: 'codex61-sol',
  };
  const scope = { ...principal, callId: 'call-1', generation: 1 };
  let request: LiveMeetingRequest = {
    scope,
    request: { id: 'request-1', revision: 'r1', text: '开始听 Google Chrome' },
  };
  let capture: MeetingCapture = {
    running: false,
    lifecycle: 'stopped',
    paused: false,
    threadId: '',
    meetingId: '',
    startedAt: 0,
    inputs: [],
    chunks: 0,
    asrState: 'ready',
  };
  const effects: string[] = [];
  let verify: (() => Promise<boolean>) | undefined;
  let grantId: string | undefined;
  let captureOwner = 'owner';
  const share = new F317MeetingShareService({
    observeCall: async () => ({ ...request.scope, state: 'talking' }),
    observeCapture: async () => {
      await hooks.beforeShareCapture?.();
      return capture;
    },
    ownerOfThread: async () => captureOwner,
    attach: async (grant, check) => {
      effects.push('attach');
      grantId = grant.grantId;
      verify = check;
      await hooks.beforeAttach?.();
    },
    detach: async () => {
      effects.push('detach');
      grantId = undefined;
      if (hooks.detachFails) throw new Error('host_detach_failed');
    },
    isAttached: (grant) => grantId === grant.grantId,
  });
  const service = new LiveMeetingControl(
    {
      authorize: async (p, id) => {
        assert.equal(p.userId, request.scope.userId);
        if (id && id !== request.request?.id) throw new Error('meeting_request_unavailable');
        return request;
      },
      ownerOfThread: async () => captureOwner,
      audio: {
        sources: async () => [{ id: 'com.google.Chrome#pid=42', name: 'Google Chrome' }],
        status: async () => (hooks.observeStatus ? hooks.observeStatus(capture) : capture),
        start: async (input) => {
          effects.push('start');
          await hooks.beforeStart?.(input);
          capture = {
            ...capture,
            running: true,
            lifecycle: 'running',
            threadId: input.threadId,
            meetingId: input.meetingId,
            startedAt: 100,
            inputs: [
              {
                id: 'primary',
                source: 'app',
                label: input.source.name,
                appName: input.source.id,
                state: 'running',
                signal: { state: 'silent', pcmBytes: 96000, peakAbs: 0 },
              },
            ],
          };
          return capture;
        },
        stop: async (target) => {
          assert.equal(share.current(), null, 'revocation must precede controller stop');
          if (verify) assert.equal(await verify(), false);
          assert.equal(target.meetingId, capture.meetingId);
          effects.push('stop');
          await hooks.beforeStop?.();
          if (hooks.stopFails) throw new Error('sidecar_stop_failed');
          capture = { ...capture, running: false, lifecycle: 'stopped' };
        },
      },
    },
    share,
  );
  return {
    principal,
    service,
    share,
    effects,
    setCaptureOwner: (owner: string) => {
      captureOwner = owner;
    },
    getCapture: () => capture,
    setCapture: (c: MeetingCapture) => {
      capture = c;
    },
    setScope: (callId: string) => {
      request = { ...request, scope: { ...request.scope, callId } };
    },
    setRequest: (text: string, id = 'request-2') => {
      request = { scope: request.scope, request: { id, revision: id, text } };
    },
  };
}
