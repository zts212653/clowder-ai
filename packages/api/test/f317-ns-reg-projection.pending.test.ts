// F317 north-star regression harness, Tier B remainder — STILL PENDING after candidate d5d293aa2e.
// This file asserts nothing. Everything the foundation cut delivers is now bound to real tests:
//   f317-ns-reg-cand-transcript.test.ts  projectLiveTranscript: same-call only, result/legacy/forged refused,
//                                        store order, 32-row / 24000-char / 16000-per-row bounds, field allow-list
//   f317-ns-reg-cand-route.test.ts       GET /api/concierge/live/:id/transcript: active vs retired call, owner only,
//                                        malformed input, 409, read-only, the 256-row scan window
//   f317-ns-reg-cand-sessions.test.ts    LiveCompanionSessions.withOwnerPreferenceChange: failure, scope, re-entry
// Tier A (f317-ns-reg-live-source / -bridge-view / -owner-read, desktop/plugin-window/f317-ns-reg-view) keeps pinning
// what must survive. What is left below has no candidate surface to bind to yet.
import { describe, test } from 'node:test';

describe('caption state the foundation cut does not carry yet', () => {
  test.todo(
    'unconfirmed send: the projection has no delivery field, so a typed row that was saved but never accepted looks identical to an accepted one. ' +
      'Plan: "发送中防重复，未确认保留草稿、原重试 ID". Needs a state on the projected message (or a sibling read) before it can be asserted.',
  );
  test.todo(
    'four states stay separate — saved, background-accepted, received by the voice layer, actually played — and accepting a send never surfaces "played". ' +
      'Plan: "保存、后台接受、语音层收到、实际播出分开". Today only saved/accepted exist (exposureReason); nothing records playback.',
  );
  test.todo(
    'a temporary bubble and its saved record merge by the stable id only (clientMessageId for typing, nativeItemId for speech), never by text. ' +
      'The stable ids now exist in the projection; the merge itself lives in the public renderer (B) and needs the exact B version.',
  );
});

describe('view state (needs the B public contract and the native view commands)', () => {
  test.todo(
    'opening/closing subtitles or chat, switching threads and resizing create or end no call and leave microphone, mute, speaker, share and audioMode as they were. ' +
      "Today's commands are pinned at bridge level (f317-ns-reg-bridge-view) and native level (desktop/plugin-window/f317-ns-reg-view); the new subtitle view commands do not exist yet.",
  );
  test.todo(
    'listen-only stays microphone-free while subtitles are open: no microphone command and no getUserMedia when the subtitle view is toggled during receive_only.',
  );
  test.todo(
    'the hang-up control stays reachable in every layout combination at or below 420 x 500 (wide, narrow, sharing, error, long text).',
  );
});

describe('cards and settings (batch 2)', () => {
  test.todo(
    'exact N only from a complete source: partial shows "not fully read" with retry, failure is not "nothing", auth-failed is not "nothing", empty is a real empty; counts are never a sum across work groups. ' +
      'Today readCompanionDecisions accepts only status "available" (pinned in f317-ns-reg-owner-read); the other four states do not exist yet.',
  );
  test.todo(
    'a source the viewer may not read is not exposed to the plugin; navigation returns to the exact source and the inbox opens the same source.',
  );
  test.todo(
    'settings migration end to end: the Hub entry reaches withOwnerPreferenceChange (stop, confirmed closed, then save) and the native side acknowledges the media stop. ' +
      'The server-side fence is bound (f317-ns-reg-cand-sessions); the Hub entry and native acknowledgement are not delivered yet.',
  );
});
