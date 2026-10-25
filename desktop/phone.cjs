const fs = require('node:fs');
const path = require('node:path');

function phoneOrigin(value) {
  if (typeof value !== 'string' || value.length > 253) throw new Error('Enter your Tailscale HTTPS address.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the exact https://device.tailnet.ts.net address from Tailscale Serve.');
  return url.origin;
}

function loadPhone(file) {
  try { if (fs.statSync(file).size > 2048) return { enabled: false, origin: '' }; const value = JSON.parse(fs.readFileSync(file, 'utf8')); return { enabled: value.enabled === true, origin: phoneOrigin(value.origin) }; }
  catch { return { enabled: false, origin: '' }; }
}

function savePhone(file, value) {
  if (!value || typeof value.enabled !== 'boolean') throw new Error('Invalid phone connection setting.');
  const next = { enabled: value.enabled, origin: value.origin ? phoneOrigin(value.origin) : '' };
  if (next.enabled && !next.origin) throw new Error('Enter your Tailscale HTTPS address first.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  return next;
}
function detectedPhoneOrigin(text) {
  if (typeof text !== 'string' || text.length > 65536) return null;
  const config = JSON.parse(text), candidates = [];
  for (const [host, web] of Object.entries(config.Web ?? {}).slice(0, 32)) {
    if (config.AllowFunnel?.[host] === true || web?.Handlers?.['/']?.Proxy !== 'http://127.0.0.1:4317') continue;
    try { candidates.push(phoneOrigin(`https://${host}`)); } catch { /* Ignore other services. */ }
  }
  return candidates.length === 1 ? candidates[0] : null;
}
module.exports = { phoneOrigin, loadPhone, savePhone, detectedPhoneOrigin };
