const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adeDesktop', {
  customTitleBar: process.platform === 'win32',
  setTheme: theme => ipcRenderer.invoke('ade:set-theme', theme),
  updateStatus: () => ipcRenderer.invoke('ade:update-status'),
  checkForUpdates: () => ipcRenderer.invoke('ade:update-check'),
  updateAndRestart: () => ipcRenderer.invoke('ade:update-update'),
  onUpdateStatus: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('ade:update-status', listener);
    return () => ipcRenderer.removeListener('ade:update-status', listener);
  },
  chooseFolder: () => ipcRenderer.invoke('ade:choose-folder'),
  setNotifications: settings => ipcRenderer.invoke('ade:notification-settings', settings),
  onAgentNotification: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('ade:agent-notification', listener);
    return () => ipcRenderer.removeListener('ade:agent-notification', listener);
  },
});
