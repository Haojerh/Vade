const { existsSync, writeFileSync, openSync, readSync, closeSync, unlinkSync } = require('node:fs');
const path = require('node:path');

const RELEASES = { provider: 'github', owner: 'Haojerh', repo: 'Vade', private: false, releaseType: 'release' };
const INTERVAL = 6 * 60 * 60 * 1000;

/** Fixed public feed. The renderer can never provide URLs, paths or updater options. */
class DesktopUpdater {
  constructor(app, window, ipcMain, origin) {
    this.app = app; this.window = window; this.closed = false;
    this.status = { state: 'idle', currentVersion: app.getVersion(), latestVersion: null, percent: null, checkedAt: null, message: null };
    this.routeFile = path.join(app.getPath('userData'), 'update-resume.json');
    const trusted = event => {
      if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Desktop updates are only available to Vade');
    };
    for (const [channel, action] of [['status', () => this.status], ['check', () => this.check()], ['update', () => this.update()]]) {
      ipcMain.handle(`ade:update-${channel}`, (event, ...args) => { trusted(event); if (args.length) throw new Error('Update actions accept no arguments'); return action(); });
    }
    window.webContents.on('did-finish-load', () => this.publish());
    window.once('closed', () => this.close());
    if (!app.isPackaged) {
      this.set({ state: 'unsupported', message: 'Automatic updates are available in packaged desktop builds.' }); return;
    }
    if (process.platform === 'linux' && !process.env.APPIMAGE) {
      this.set({ state: 'unsupported', message: 'Automatic updates require an AppImage installation on Linux.' }); return;
    }
    try {
      // Load lazily: electron-updater initializes against the packaged app version.
      this.updater = require('electron-updater').autoUpdater;
      this.updater.autoDownload = false;
      this.updater.autoInstallOnAppQuit = false;
      this.updater.allowPrerelease = false;
      this.updater.allowDowngrade = false;
      this.updater.setFeedURL(RELEASES);
      this.updater.logger = null;
      this.updater.on('checking-for-update', () => this.set({ state: 'checking', message: null }));
      this.updater.on('update-available', info => {
        if (this.closed || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(info.version)) return;
        this.set({ state: 'available', latestVersion: info.version, percent: null, checkedAt: new Date().toISOString(), message: null });
      });
      this.updater.on('update-not-available', () => this.set({ state: 'current', latestVersion: null, percent: null, checkedAt: new Date().toISOString(), message: null }));
      this.updater.on('download-progress', progress => {
        if (this.status.state !== 'downloading') return;
        this.set({ percent: Math.max(0, Math.min(100, Number.isFinite(progress.percent) ? Math.round(progress.percent) : 0)) });
      });
      this.updater.on('update-downloaded', info => {
        if (info.version !== this.status.latestVersion) return;
        this.set({ state: 'ready', percent: 100, message: null });
        if (this.installAfterDownload) this.install();
      });
      this.updater.on('error', () => this.failed(this.status.state === 'checking' ? 'check' : this.status.state === 'installing' ? 'install' : 'download'));
      this.timer = setTimeout(() => void this.check(), 3000);
      this.interval = setInterval(() => void this.check(), INTERVAL);
      this.timer.unref(); this.interval.unref();
    } catch { this.failed('check'); }
  }
  publish() {
    if (!this.closed && !this.window.isDestroyed()) this.window.webContents.send('ade:update-status', { ...this.status });
  }
  set(patch) { if (this.closed) return; this.status = { ...this.status, ...patch }; this.publish(); }
  failed(stage) {
    this.installAfterDownload = false;
    const message = stage === 'check' ? 'Could not check GitHub Releases. Check your connection and that a desktop release has been published.' : stage === 'install' ? 'The update could not be installed. Retry from Installation settings.' : 'The update download failed. Retry from Installation settings.';
    this.set({ state: 'error', percent: null, message });
  }
  async check() {
    if (!this.updater || this.closed || ['downloading','ready','installing'].includes(this.status.state)) return this.status;
    if (this.checking) return this.checking;
    this.set({ state: 'checking', message: null });
    this.checking = Promise.resolve().then(() => this.updater.checkForUpdates()).catch(() => this.failed('check')).finally(() => { this.checking = null; });
    await this.checking; return this.status;
  }
  async update() {
    if (!this.updater || this.closed) return this.status;
    if (this.status.state === 'ready') { this.install(); return this.status; }
    if (this.downloading || !['available','error'].includes(this.status.state) || !this.status.latestVersion) return this.status;
    this.installAfterDownload = true;
    this.set({ state: 'downloading', percent: 0, message: null });
    this.downloading = Promise.resolve().then(() => this.updater.downloadUpdate()).catch(() => this.failed('download')).finally(() => { this.downloading = null; });
    // Return acceptance immediately; progress arrives over the trusted event channel.
    return this.status;
  }
  install() {
    if (!this.updater || this.closed || this.status.state !== 'ready') return;
    this.set({ state: 'installing', message: null });
    try {
      const url = new URL(this.window.webContents.getURL());
      if (url.origin === 'http://127.0.0.1:4317' && url.pathname === '/' && url.href.length <= 4096) writeFileSync(this.routeFile, JSON.stringify({ route: url.pathname + url.search + url.hash }), { mode: 0o600 });
      // Main's normal before-quit handler shuts down the owned backend first.
      this.updater.quitAndInstall(true, true);
    } catch { this.failed('install'); }
  }
  resumeRoute() {
    try {
      if (!existsSync(this.routeFile)) return '/';
      const fd = openSync(this.routeFile, 'r'), bytes = Buffer.alloc(8193); let size;
      try { size = readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
      unlinkSync(this.routeFile);
      if (size > 8192) return '/';
      const route = JSON.parse(bytes.subarray(0,size).toString()).route;
      if (typeof route !== 'string' || route.length > 4096) return '/';
      const url = new URL(route, 'http://127.0.0.1:4317');
      return url.origin === 'http://127.0.0.1:4317' && url.pathname === '/' ? url.pathname + url.search + url.hash : '/';
    } catch { return '/'; }
  }
  close() { this.closed = true; clearTimeout(this.timer); clearInterval(this.interval); }
}
module.exports = { DesktopUpdater };
