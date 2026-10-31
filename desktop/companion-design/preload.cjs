const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('companionDesign', {
  resize: (mode) => {
    if (['compact', 'narrow', 'normal'].includes(mode)) ipcRenderer.send('design:resize', mode);
  },
  point: () => ipcRenderer.send('design:point'),
  clearPoint: () => ipcRenderer.send('design:clear-point'),
  onPoint: (callback) => ipcRenderer.on('design:point-selected', (_event, point) => callback(point)),
});
