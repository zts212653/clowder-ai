const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('live', {
  info: () => ipcRenderer.invoke('live:info'),
  documents: () => ipcRenderer.invoke('live:documents'),
  arm: () => ipcRenderer.invoke('live:arm'),
  start: (sdp) => ipcRenderer.invoke('live:start', sdp),
  stop: () => ipcRenderer.invoke('live:stop'),
  text: (text, clientMessageId) => ipcRenderer.invoke('live:text', text, clientMessageId),
  screenRequest: () => ipcRenderer.invoke('live:screen-request'),
  screenStart: (id, label) => ipcRenderer.invoke('live:screen-start', id, label),
  screenFrame: (id, frame) => ipcRenderer.invoke('live:screen-frame', id, frame),
  screenStop: () => ipcRenderer.invoke('live:screen-stop'),
  fixture: () => ipcRenderer.invoke('live:fixture'),
  audioEvidence: (data) => ipcRenderer.invoke('live:audio-evidence', data),
  resize: (expanded) => ipcRenderer.send('live:resize', expanded),
  record: (value) => ipcRenderer.send('live:record', value),
  onEvent: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('live:event', listener);
    return () => ipcRenderer.removeListener('live:event', listener);
  },
});
