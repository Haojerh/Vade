const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adeDesktop', {
  customTitleBar: process.platform === 'win32',
  chooseFolder: () => ipcRenderer.invoke('ade:choose-folder'),
  setNotifications: settings => ipcRenderer.invoke('ade:notification-settings', settings),
  onAgentNotification: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('ade:agent-notification', listener);
    return () => ipcRenderer.removeListener('ade:agent-notification', listener);
  },
});
