// preload.js — Exposes safe IPC bridge to splash page
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clowder', {
  onStatus: (callback) => ipcRenderer.on('splash-status', (_e, msg) => callback(msg)),
});
