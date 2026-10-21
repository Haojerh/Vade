const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adeDesktop', {
  chooseFolder: () => ipcRenderer.invoke('ade:choose-folder'),
});
