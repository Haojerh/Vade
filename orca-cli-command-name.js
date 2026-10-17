"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrcaCliCommandNameForPlatform = getOrcaCliCommandNameForPlatform;
function getOrcaCliCommandNameForPlatform(platform) {
    if (platform === 'linux') {
        return 'orca-ide';
    }
    if (platform === 'win32') {
        return 'orca.cmd';
    }
    return 'orca';
}
