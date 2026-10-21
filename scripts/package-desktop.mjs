import { createRequire } from 'node:module';
import path from 'node:path';
import { build, Platform } from 'electron-builder';

const require = createRequire(import.meta.url);
// Electron's npm package may install its binary lazily. Resolve it before packaging,
// then copy that verified distribution instead of extracting a second download.
const electron = require('electron');
// A previous unpacked app may still have its ASAR open on Windows.
const output = path.join('release', new Date().toISOString().replace(/[:.]/g, '-'));
await build({ targets: Platform.current().createTarget('dir'), config: { electronDist: path.dirname(electron), directories: { output } } });
console.log(`Desktop output: ${path.resolve(output)}`);
