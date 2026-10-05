const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ORIGIN, allowMicrophone, allowDisplayCapture, validateOffer } = require('./policy.cjs');
const { ConnectionEpoch } = require('./epoch.mjs');

test('only the clicked local voice surface can receive microphone permission', () => {
  const valid = { url: `${ORIGIN}/`, permission: 'media', mediaTypes: ['audio'], armed: true };
  assert.equal(allowMicrophone(valid), true);
  for (const override of [
    { armed: false },
    { url: 'https://example.com/' },
    { url: `${ORIGIN}/other` },
    { mediaTypes: ['video'] },
    { mediaTypes: ['audio', 'video'] },
    { mediaTypes: [] },
    { permission: 'display-capture' },
  ])
    assert.equal(allowMicrophone({ ...valid, ...override }), false);
});

test('a bounded audio SDP is accepted, malformed and oversized input rejected', () => {
  const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
  assert.equal(validateOffer(sdp), sdp);
  for (const bad of [null, {}, 'hello', 'v=0\r\nm=video 9 RTP/AVP 96', sdp.repeat(10000)]) {
    assert.throws(() => validateOffer(bad));
  }
});

test('display capture requires the clicked surface and a pending current selection', () => {
  const valid = { url: `${ORIGIN}/`, permission: 'display-capture', armed: true, selectionId: 'selection' };
  assert.equal(allowDisplayCapture(valid), true);
  for (const override of [
    { armed: false },
    { selectionId: undefined },
    { url: 'https://elsewhere/' },
    { permission: 'media' },
  ])
    assert.equal(allowDisplayCapture({ ...valid, ...override }), false);
});

test('Electron 35 display requests use media with an empty device list, only during exact screen selection', () => {
  // v35.7.5 WebContentsPermissionHelper::RequestMediaAccessPermission:
  // only DEVICE_AUDIO/VIDEO add mediaTypes; DISPLAY_VIDEO reaches the media permission with [].
  const request = { url: `${ORIGIN}/`, permission: 'media', mediaTypes: [], armed: true, selectionId: 'clicked' };
  assert.equal(allowDisplayCapture(request), true);
  for (const override of [
    { armed: false },
    { selectionId: undefined },
    { url: 'https://elsewhere/' },
    { mediaTypes: ['video'] },
    { mediaTypes: ['audio'] },
    { mediaTypes: undefined },
  ])
    assert.equal(allowDisplayCapture({ ...request, ...override }), false);
});

test('ending during permission or SDP negotiation fences all late continuations', () => {
  const epoch = new ConnectionEpoch();
  const first = epoch.begin();
  assert.equal(epoch.current(first), true);
  epoch.end();
  assert.equal(epoch.current(first), false);
  const second = epoch.begin();
  assert.equal(epoch.current(first), false);
  assert.equal(epoch.current(second), true);
});
