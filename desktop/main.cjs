const { app, BrowserWindow, dialog, utilityProcess, shell, ipcMain } = require('electron');
const path = require('node:path');

let backend;
let quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName('Vade');
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.whenReady().then(async () => {
    backend = utilityProcess.fork(path.join(__dirname, '../build/server.cjs'), [], {
      cwd: app.getAppPath(),
      env: { ...process.env, ADE_DIST_DIR: path.join(app.getAppPath(), 'dist'), ADE_PTY_HOST: path.join(app.getAppPath(), 'build/ptyHost.cjs') },
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
          titleBarOverlay: { color: '#202020', symbolColor: '#d4d4d4', height: 35 },
        } : {}),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.cjs') } });
      window.setMenuBarVisibility(false);
      window.removeMenu();
      const origin = 'http://127.0.0.1:4317';
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
      await window.loadURL(origin);
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
