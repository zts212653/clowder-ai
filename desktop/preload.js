// preload.js — Exposes narrow, context-isolated splash and update IPC bridges.
const { contextBridge, ipcRenderer } = require('electron');

const UPDATE_ACTIONS = new Set(['download', 'install', 'later', 'skip', 'open-release', 'dismiss']);
const apiOrigin = process.argv
  .find((arg) => arg.startsWith('--cat-cafe-api-origin='))
  ?.split('=')
  .slice(1)
  .join('=');
const appOrigin = process.argv
  .find((arg) => arg.startsWith('--cat-cafe-app-origin='))
  ?.split('=')
  .slice(1)
  .join('=');

// Preload runs before the web application: seed only a missing/invalid desktop
// preference, so first launch paints v2 without overriding a later classic choice.
// The splash page and other origins/subframes must not receive this preference.
if (appOrigin && typeof window !== 'undefined' && window.top === window && window.location.origin === appOrigin) {
  try {
    const key = 'cat-cafe:shell-presentation';
    const preference = window.localStorage.getItem(key);
    if (preference !== 'classic' && preference !== 'v2') {
      window.localStorage.setItem(key, 'v2');
      console.info('[desktop-shell] initialized preference=v2');
    } else {
      console.info(`[desktop-shell] retained preference=${preference}`);
    }
  } catch {
    console.warn('[desktop-shell] preference storage unavailable');
  }
}

contextBridge.exposeInMainWorld('desktopBridge', {
  apiOrigin,
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
