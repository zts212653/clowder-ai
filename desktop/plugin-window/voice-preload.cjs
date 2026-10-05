const { ipcRenderer } = require('electron');
// Runs only in the fixed Host media document, never in package webContents.
let voice,
  epoch = 0;
const denied = (code) => ({ kind: 'error', code });
function voiceEvent(event, current) {
  if (current !== epoch) return;
  const value = { kind: 'audio', type: event.type };
  if (['connected', 'recovering', 'recovered', 'error'].includes(event.type))
    return ipcRenderer.send('companion:voice-event', value);
  if (event.type === 'turn-created') {
    if (event.role !== 'user' || !/^[A-Za-z0-9_-]{1,160}$/.test(event.turnId)) return;
    return ipcRenderer.send('companion:voice-event', { ...value, role: 'user', turnId: event.turnId });
  }
  if (!['transcript', 'turn-done'].includes(event.type)) return;
  if (event.type === 'transcript' && (!['user', 'assistant'].includes(event.role) || typeof event.text !== 'string'))
    return;
  for (const key of ['text', 'transcript']) {
    if (event[key] !== undefined) {
      if (typeof event[key] !== 'string' || event[key].length > 16000) return;
      value[key] = event[key];
    }
  }
  if (['user', 'assistant'].includes(event.role)) value.role = event.role;
  for (const key of ['turnId', 'itemId']) {
    if (typeof event[key] === 'string' && event[key].length > 0 && event[key].length <= 256) value[key] = event[key];
  }
  ipcRenderer.send('companion:voice-event', value);
}
async function request(command) {
  if (command.kind === 'audio.microphone') {
    if (voice?.muteMic(command.muted) === false) return denied('permission_required');
    return { kind: 'ok' };
  }
  if (command.kind === 'audio.speaker') {
    voice?.muteSpeaker(command.muted);
    return { kind: 'ok' };
  }
  if (command.kind !== 'audio.connect') return denied('invalid_request');
  if (command.mode !== undefined && command.mode !== 'receive_only') return denied('invalid_request');
  if (voice) return denied('busy');
  const current = ++epoch;
  const peer = new HostVoice((event) => voiceEvent(event, current));
  voice = peer;
  if (command.mode !== 'receive_only') peer.muteMic(command.microphoneMuted);
  peer.muteSpeaker(command.speakerMuted);
  try {
    const sdp = await (command.mode === 'receive_only' ? peer.offer({ microphone: 'none' }) : peer.offer());
    if (current !== epoch) return denied('cancelled');
    const reply = await ipcRenderer.invoke('companion:media-offer', sdp);
    if (current !== epoch) return denied('cancelled');
    if (reply.kind !== 'answer' || typeof reply.sdp !== 'string') throw new Error('Unavailable');
    await peer.answer(reply.sdp);
    return current === epoch ? { kind: 'ok' } : denied('cancelled');
  } catch {
    if (voice === peer) {
      voice = undefined;
      ++epoch;
    }
    await peer.close();
    return denied('unavailable');
  }
}
ipcRenderer.on('companion:voice-command', (_event, id, command) => {
  void request(command)
    .catch(() => denied('unavailable'))
    .then((reply) => ipcRenderer.send('companion:voice-reply', id, reply));
});
