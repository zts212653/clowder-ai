export function realtimeStartParams(threadId, sdp, instructions) {
  return {
    threadId,
    outputModality: 'audio',
    version: 'v3',
    transport: { type: 'webrtc', sdp },
    includeStartupContext: false,
    clientManagedHandoffs: false,
    initialItems: [{ role: 'developer', text: instructions }],
  };
}
