// preload.js — Exposes narrow, context-isolated desktop IPC bridges.
const { contextBridge, ipcRenderer } = require('electron');

const UPDATE_ACTIONS = new Set(['download', 'install', 'later', 'skip', 'open-release', 'dismiss']);
const WORKSPACE_OPEN_HTML_CHANNEL = 'desktop-workspace:open-html';

function isWorkspaceHtmlTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
  if (Object.keys(target).length !== 2) return false;
  if (typeof target.worktreeId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(target.worktreeId)) return false;
  if (typeof target.path !== 'string' || target.path.length === 0 || target.path.length > 4096) return false;
  if (target.path.includes('\\') || target.path.startsWith('/') || /^[a-z]:/i.test(target.path)) return false;
  const segments = target.path.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..') && /\.html?$/i.test(target.path);
}

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
  openWorkspaceHtml: (target) => {
    if (!isWorkspaceHtmlTarget(target)) throw new TypeError('Invalid Workspace HTML target');
    return ipcRenderer.invoke(WORKSPACE_OPEN_HTML_CHANNEL, {
      worktreeId: target.worktreeId,
      path: target.path,
    });
  },
});
