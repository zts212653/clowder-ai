// preload.js — Exposes a safe IPC bridge to the splash page
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
  onStatus: (callback) => ipcRenderer.on('splash-status', (_e, msg) => callback(msg)),
});
