const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pointDesign', {
  select: (x, y) => {
    if (Number.isFinite(x) && Number.isFinite(y)) ipcRenderer.send('design:selected', { x, y });
  },
  cancel: () => ipcRenderer.send('design:point-cancel'),
});
