const { app, BrowserWindow, dialog, utilityProcess, shell, ipcMain, Notification } = require('electron');
const path = require('node:path');
const { DesktopUpdater } = require('./updater.cjs');

let backend;
let quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName('Vade');
  if (process.platform === 'win32') app.setAppUserModelId('dev.ade.desktop');
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(async () => {
    backend = utilityProcess.fork(path.join(__dirname, '../build/server.cjs'), [], {
      cwd: app.getAppPath(),
      env: { ...process.env, ADE_DIST_DIR: path.join(app.getAppPath(), 'dist'), ADE_PTY_HOST: path.join(app.getAppPath(), 'build/ptyHost.cjs'), ADE_SPEECH_WORKER: path.join(app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'build/speechWorker.cjs'), ADE_ORCHESTRATION_RESOURCES: path.join(app.getAppPath(), 'build/orchestration') },
      stdio: 'pipe', serviceName: 'ADE local runtime',
    });
    backend.stdout?.on('data', data => process.stdout.write(data));
    backend.stderr?.on('data', data => process.stderr.write(data));
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The ADE backend did not start within 20 seconds.')), 20000);
      backend.once('message', message => { clearTimeout(timeout); if (message?.type === 'ready') resolve(); else reject(new Error('Unexpected backend startup response.')); });
      backend.once('exit', code => { clearTimeout(timeout); reject(new Error(`ADE backend exited (${code}). Check whether port 4317 is already in use.`)); });
    });
    try {
      await ready;
      // Electron reports its own main/renderer/GPU/utility processes; agents are separate.
      const reportMemory = () => {
        const metrics = app.getAppMetrics();
        backend?.postMessage({ type: 'desktop-memory', bytes: metrics.reduce((total, metric) => total + metric.memory.workingSetSize * 1024, 0), pids: metrics.map(metric => metric.pid) });
      };
      reportMemory();
      const memoryTimer = setInterval(reportMemory, 5000);
      backend.once('exit', () => clearInterval(memoryTimer));
      const window = new BrowserWindow({ width: 1440, height: 920, minWidth: 760, minHeight: 540,
        title: 'Vade', show: false, backgroundColor: '#181818',
        ...(process.platform === 'win32' ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#00000000', symbolColor: '#d4d4d4', height: 35 },
        } : {}),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') } });
      window.setMenuBarVisibility(false);
      window.removeMenu();
      const origin = 'http://127.0.0.1:4317';
      const updater = new DesktopUpdater(app, window, ipcMain, origin);
      let notificationSettings = { enabled: true, sound: true };
      const notifications = new Map();
      ipcMain.handle('ade:notification-settings', (event, value) => {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Notifications are only available to ADE');
        if (!value || typeof value.enabled !== 'boolean' || typeof value.sound !== 'boolean') throw new Error('Invalid notification settings');
        notificationSettings = { enabled: value.enabled, sound: value.sound };
        if (!value.enabled) { for (const notification of notifications.values()) notification.close(); notifications.clear(); }
      });
      backend.on('message', message => {
        if (!['agent-completed', 'agent-question'].includes(message?.type) || window.isDestroyed()) return;
        const item = message.item;
        window.webContents.send('ade:agent-notification', { item, open: false });
        if (!notificationSettings.enabled || window.isFocused() || !Notification.isSupported() || notifications.has(item.id)) return;
        const notification = new Notification({ title: item.source === 'attention' ? 'Agent needs an answer' : 'Agent finished', body: `${item.projectName} — ${item.title}`, icon: path.join(app.getAppPath(), 'dist', 'vade-notification.png'), silent: !notificationSettings.sound });
        notifications.set(item.id, notification);
        while (notifications.size > 32) { const [id, oldest] = notifications.entries().next().value; oldest.close(); notifications.delete(id); }
        notification.on('click', () => {
          if (window.isDestroyed()) return;
          if (window.isMinimized()) window.restore();
          window.show(); window.focus();
          window.webContents.send('ade:agent-notification', { item, open: true });
        });
        notification.on('close', () => notifications.delete(item.id));
        notification.on('failed', () => notifications.delete(item.id));
        notification.show();
      });
      window.on('closed', () => { for (const notification of notifications.values()) notification.close(); notifications.clear(); });
      ipcMain.handle('ade:choose-folder', async event => {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Folder picker is only available to ADE');
        const result = await dialog.showOpenDialog(window, { title: 'Choose a project folder', properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0] ?? null;
      });
      window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
      window.webContents.setWindowOpenHandler(({ url }) => {
        try { if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url); } catch { /* Keep malformed and non-web targets closed. */ }
        return { action: 'deny' };
      });
      window.once('ready-to-show', () => window.show());
      backend.on('exit', () => { if (!quitting) { dialog.showErrorBox('ADE runtime stopped', 'The local backend stopped. Restart ADE to reconnect.'); app.quit(); } });
      await window.loadURL(origin + updater.resumeRoute());
    } catch (error) { dialog.showErrorBox('ADE could not start', error.message); app.quit(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !backend) return;
    event.preventDefault(); quitting = true;
    backend.once('exit', () => app.quit());
    backend.postMessage('shutdown');
    setTimeout(() => { backend.kill(); app.quit(); }, 3000).unref();
  });
}
