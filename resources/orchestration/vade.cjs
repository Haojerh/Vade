#!/usr/bin/env node
// Vade's fixed, capability-scoped workflow control client. No shell/CLI passthrough.
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('vade orchestration 1.0.0'); process.exit(0); }
async function main() {
  let identityFile = process.env.VADE_IDENTITY_FILE;
  if (args[0] === '--identity') { args.shift(); identityFile = args.shift(); }
  const action = args.shift();
  const allowed = ['context', 'models', 'begin', 'plan', 'dispatch', 'message', 'result', 'integrate', 'finish', 'cancel', 'wait'];
  if (!identityFile || !allowed.includes(action)) throw new Error('Usage: node vade.cjs [--identity <file>] context|models|begin|plan|dispatch|message|result|integrate|finish|cancel|wait [JSON object]');
  const stat = fs.statSync(identityFile); if (!stat.isFile() || stat.size > 8192) throw new Error('Invalid workflow identity');
  const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
  const endpoint = new URL(identity.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/api/workflow/control') throw new Error('Invalid local workflow endpoint');
  const raw = args.shift(); if (args.length || (raw && raw.length > 131072)) throw new Error('Expected one bounded JSON object');
  const value = raw ? JSON.parse(raw) : {};
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected a JSON object');
  async function call(command) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.token}` }, body: JSON.stringify({ ...value, action: command, ...(identity.runId ? { runId: identity.runId } : {}), sessionId: identity.sessionId }), signal: AbortSignal.timeout(45000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || 'Workflow request failed'); return result;
  }
  if (action === 'wait') {
    // Read-only bounded polling. A timeout never repeats a mutation.
    const started = Date.now(); let result = await call('context'); if (!result.run) throw new Error('No active run. Read context and explicitly begin before waiting.'); const revision = result.run.updatedAt;
    while (Date.now() - started < 55000 && result.run && result.run.updatedAt === revision && !result.ready?.length && result.run.steps.some(step => ['starting','running'].includes(step.state)) && !['blocked','completed','failed','cancelled'].includes(result.run.state)) {
      await new Promise(resolve => setTimeout(resolve, 1500)); result = await call('context');
    }
    console.log(JSON.stringify(result));
  } else console.log(JSON.stringify(await call(action)));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
