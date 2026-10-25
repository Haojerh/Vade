# Desktop updates

Desktop windows use the short title `Vade`. The shared title bar follows the saved appearance preference; a main-frame/origin-restricted IPC accepts only `light` or `dark` and applies fixed matching window/caption colors. Browser content supplies no native colors or window flags.

Vade checks the stable public GitHub Releases feed for `Haojerh/ADE` three seconds after startup and every six hours while open. Settings → Installation / Setup puts the desktop app version and Check for updates first. A newer release creates a persistent in-app notification at the bottom right, above the status bar. Agent notifications stack above its measured height. Closing it dismisses that version across relaunches; the Installation page always retains the update controls.

**Update & restart** authorizes a download and automatic installation/relaunch when it finishes. Checks never download or restart by themselves. Electron-updater validates the release artifact against its manifest; existing platform signature checks remain enabled. Development Electron launches explicitly report that updates require a packaged build. Linux auto-updates require AppImage; macOS requires properly signed release builds. Browser mode cannot install desktop updates.

`desktop/updater.cjs` owns the fixed release feed, version, progress and install lifecycle. `desktop/main.cjs` restricts IPC to the trusted main frame, shuts down the owned backend during the normal quit flow, and restores a bounded same-origin route after an update. The sandboxed preload exposes only status, check, update/restart and status subscriptions. No renderer-provided feed, executable, installer path or flags are accepted. Update notices have no expiry timer and do not depend on agent notification preferences.

## Producing releases

Packaged backend utility processes use the real Electron resources directory as their working directory. `app.getAppPath()` points inside `app.asar` in an installed build and cannot serve as a native Windows process cwd. Bundled file locations remain explicit absolute paths. Speech and PTY workers must appear in both the packaged file list and ASAR-unpack rules. System Node launches the PTY helper from its real unpacked path; it cannot read Electron's virtual archive paths.

Speech addon discovery uses the application root from `ADE_DIST_DIR` and resolves its platform package directly inside `app.asar.unpacked/node_modules`. It does not search from the resources cwd or fall back to an adjacent host-installed addon. `scripts/verify-desktop-speech.mjs` runs the production resolver and loads the native API using the packaged Windows executable in Node mode, with resources as cwd, before packaging reports success. This validates addon loading and worker presence without downloading models or recording audio.

`npm run package:desktop` keeps the unpacked development build. `npm run package:release` creates an installer and updater metadata without publishing. Windows uses a per-user NSIS installer; macOS produces DMG/ZIP; Linux produces AppImage. Release files are placed in a timestamped directory under `release/`.

Desktop builds render `src/assets/brand/vade.svg` into the packaged app PNG and a multi-resolution Windows ICO through `scripts/build-brand-icons.mjs`. The application, installer, uninstaller, desktop shortcut and Start menu entry use Vade branding. The per-user Windows setup creates both shortcuts and preserves application data on uninstall.

The Windows GitHub Actions workflow in `.github/workflows/desktop-release.yml` runs when a stable `vX.Y.Z` tag is pushed. The tag must match `package.json`. It builds and publishes the NSIS installer, its blockmap and `latest.yml` to the same GitHub Release, using the repository's built-in Actions token. Optional `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` secrets configure normal Windows signing. Credentials stay in the build environment. No release is published by ordinary local builds.

The selected repository had no publicly readable latest release when this was implemented. A newer release with its installer and `latest.yml` must be published before an installed app can receive a real update. Until a feed is readable, the UI reports a check failure rather than claiming the app is up to date. Publishing and a real install/relaunch cycle require that release; simulated lifecycle checks do not establish live OTA delivery.

References: Orca's [update scheduling](https://github.com/stablyai/orca/blob/main/src/main/updater/updater-scheduling.ts), [download/install coordination](https://github.com/stablyai/orca/blob/main/src/main/updater/updater-download-install.ts), and [updater events](https://github.com/stablyai/orca/blob/main/src/main/updater-events.ts), adapted to Vade's standalone main/preload boundary; electron-builder's [v26 updater API](https://www.electron.build/v26/docs/api/electron-updater.class.appupdater/). No Orca runtime dependency.
