const { contextBridge, ipcRenderer } = require('electron');
// The package gets controls, never media permissions, streams or provider IPC.
const listeners = new Set();
ipcRenderer.on('companion:event', (_event, value) => {
  for (const callback of listeners) callback(value);
});
contextBridge.exposeInMainWorld('clowderCompanion', {
  request: async (command) => {
    if (
      !command ||
      typeof command !== 'object' ||
      typeof command.kind !== 'string' ||
      command.kind === 'offer' ||
      command.kind === 'answer'
    )
      return { kind: 'error', code: 'invalid_request' };
    return ipcRenderer.invoke('companion:request', command, navigator.userActivation.isActive === true);
  },
  subscribe: (callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
});
