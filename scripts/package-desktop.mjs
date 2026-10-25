import { createRequire } from 'node:module';
import path from 'node:path';
import { build, Platform } from 'electron-builder';
import { verifyDesktopSpeech } from './verify-desktop-speech.mjs';

const require = createRequire(import.meta.url);
// Electron's npm package may install its binary lazily. Resolve it before packaging,
// then copy that verified distribution instead of extracting a second download.
const electron = require('electron');
// A previous unpacked app may still have its ASAR open on Windows.
const output = path.join('release', new Date().toISOString().replace(/[:.]/g, '-'));
const release = process.argv.includes('--release'), publish = process.argv.includes('--publish');
if (publish && !release) throw new Error('Publishing requires a release build');
const targets = release ? process.platform === 'win32' ? ['nsis'] : process.platform === 'darwin' ? ['dmg', 'zip'] : ['AppImage'] : ['dir'];
await build({ targets: Platform.current().createTarget(...targets), publish: publish ? 'always' : 'never', config: { electronDist: path.dirname(electron), directories: { output } } });
await verifyDesktopSpeech(path.resolve(output));
console.log(`Desktop output: ${path.resolve(output)}`);
