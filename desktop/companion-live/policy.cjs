const surfacePort = Number(process.env.F317_SURFACE_PORT || 3382);
if (!Number.isInteger(surfacePort) || surfacePort < 1024 || surfacePort > 65535 || [3001, 3002].includes(surfacePort))
  throw new Error('Invalid isolated Live surface port');
const ORIGIN = `http://127.0.0.1:${surfacePort}`;
function allowMicrophone({ url, permission, mediaTypes, armed }) {
  return (
    armed === true &&
    url === `${ORIGIN}/` &&
    permission === 'media' &&
    Array.isArray(mediaTypes) &&
    mediaTypes.length === 1 &&
    mediaTypes[0] === 'audio'
  );
}
function validateOffer(sdp) {
  if (
    typeof sdp !== 'string' ||
    sdp.length > 100000 ||
    !sdp.startsWith('v=0') ||
    !/^m=audio /m.test(sdp) ||
    /^m=video /m.test(sdp)
  )
    throw new Error('Invalid audio offer');
  return sdp;
}
function allowDisplayCapture({ url, permission, mediaTypes, armed, selectionId }) {
  // Electron 35 requests DISPLAY_VIDEO as "media" with no camera/mic device types.
  // This compatibility is confined to a user-created pending screen selection.
  const displayRequest =
    permission === 'display-capture' ||
    (permission === 'media' && Array.isArray(mediaTypes) && mediaTypes.length === 0);
  return (
    armed === true &&
    url === `${ORIGIN}/` &&
    displayRequest &&
    typeof selectionId === 'string' &&
    selectionId.length > 0
  );
}
module.exports = { ORIGIN, allowMicrophone, allowDisplayCapture, validateOffer };
