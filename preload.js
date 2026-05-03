const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mini', {
  openFile: () => ipcRenderer.invoke('open-file'),
  saveFile: (data) => ipcRenderer.invoke('save-file', data),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  closeWindow: () => ipcRenderer.send('close-window'),
  getThemeCSS: () => ipcRenderer.invoke('get-theme-css'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, action) => cb(action)),
  onOpenFileFromOS: (cb) =>
    ipcRenderer.on('open-file-from-os', (_e, payload) => cb(payload)),
  onZoom: (cb) =>
    ipcRenderer.on('zoom', (_e, delta) => cb(delta)),
  onAppCmd: (cb) =>
    ipcRenderer.on('app-cmd', (_e, cmd) => cb(cmd)),
});
