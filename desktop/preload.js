// preload.js — Exposes narrow, context-isolated splash and update IPC bridges.
const { contextBridge, ipcRenderer } = require('electron');

const UPDATE_ACTIONS = new Set(['download', 'install', 'later', 'skip', 'open-release', 'dismiss']);

contextBridge.exposeInMainWorld('desktopBridge', {
  onStatus: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('splash-status', listener);
    return () => ipcRenderer.removeListener('splash-status', listener);
  },
  onUpdatePrompt: (callback) => {
    const listener = (_event, prompt) => callback(prompt);
    ipcRenderer.on('desktop-update:prompt', listener);
    return () => ipcRenderer.removeListener('desktop-update:prompt', listener);
  },
  onUpdateProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('desktop-update:progress', listener);
    return () => ipcRenderer.removeListener('desktop-update:progress', listener);
  },
  getUpdateSettings: () => ipcRenderer.invoke('desktop-update:settings:get'),
  setUpdateAutoCheck: (enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('Invalid desktop update auto-check preference');
    return ipcRenderer.invoke('desktop-update:settings:set-auto-check', enabled);
  },
  updatePromptReady: () => ipcRenderer.invoke('desktop-update:ready'),
  sendUpdatePromptAction: (action, version) => {
    if (!UPDATE_ACTIONS.has(action) || typeof version !== 'string') {
      throw new TypeError('Invalid desktop update action');
    }
    ipcRenderer.send('desktop-update:action', { action, version });
  },
});
