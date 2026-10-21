const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adeDesktop', {
  customTitleBar: process.platform === 'win32',
  chooseFolder: () => ipcRenderer.invoke('ade:choose-folder'),
});
