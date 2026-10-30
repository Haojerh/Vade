import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdeStore } from '../store.js';
import { ProviderAccounts } from '../system/providerAccounts.js';
import { LocalConnections } from '../system/connections.js';
import { defaultCommandRunner, type CommandRunner } from '../../integrations/cli.js';

function fixture(runner: CommandRunner = defaultCommandRunner) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ade-accounts-test-quote' "));
  const store = new AdeStore(directory);
  return { directory, store, accounts: new ProviderAccounts(store, runner), close() {
    store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('ade-accounts-test-'));
    fs.rmSync(directory, { recursive: true });
  } };
}

test('account profiles isolate native sign-ins, persist selection, and return metadata without credentials', async () => {
  const f = fixture();
  try {
    const a = await f.accounts.add('codex', 'Personal');
    const b = await f.accounts.add('codex', 'Work');
    assert.equal(f.accounts.selected('codex'), 'system');
    assert.notEqual(a.id, b.id); assert.equal(a.detected, false);
    assert.ok(a.loginCommand.includes('CODEX_HOME'));
    if (process.platform === 'win32') assert.ok(a.loginCommand.includes("quote'' "));
    fs.writeFileSync(f.accounts.credentialPath('codex', a.id), JSON.stringify({ tokens: { access_token: 'secret-A' } }));
    fs.writeFileSync(f.accounts.credentialPath('codex', b.id), JSON.stringify({ tokens: { access_token: 'secret-B' } }));
    f.accounts.select('codex', a.id);
    assert.equal(new ProviderAccounts(f.store, defaultCommandRunner).selected('codex'), a.id);
    const metadata = await f.accounts.list('codex');
    assert.equal(metadata.find(account => account.id === a.id)?.active, true);
    assert.equal(metadata.find(account => account.id === b.id)?.detected, true);
    assert.ok(!JSON.stringify(metadata).includes('secret-'));
    assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM provider_accounts').all()).includes('secret-'));
    f.accounts.select('codex', 'system'); assert.equal(f.accounts.selected('codex'), 'system');
    assert.throws(() => f.accounts.select('claude', a.id), /Unknown provider account/);
    assert.throws(() => f.accounts.select('codex', '../outside'), /Unknown provider account/);
    await assert.rejects(f.accounts.add('codex', 'personal'), /already exists/);
    await assert.rejects(f.accounts.add('codex', 'bad\nname'), /account name/);
  } finally { f.close(); }
});

test('selected profile quotas never carry over old data or an in-flight old-account response', async () => {
  const f = fixture();
  try {
    const a = await f.accounts.add('codex', 'A'), b = await f.accounts.add('codex', 'B');
    fs.writeFileSync(f.accounts.credentialPath('codex', a.id), JSON.stringify({ tokens: { access_token: 'secret-A' } }));
    fs.writeFileSync(f.accounts.credentialPath('codex', b.id), JSON.stringify({ tokens: { access_token: 'secret-B' } }));
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const oldStarted = new Promise<void>(resolve => { started = resolve; });
    const service = new LocalConnections(defaultCommandRunner, { accounts: f.accounts, resolve: () => null,
      request: async (_url, headers) => {
        if (headers.Authorization === 'Bearer secret-A') { started(); await gate; return { rate_limit: { primary_window: { used_percent: 91 } } }; }
        assert.equal(headers.Authorization, 'Bearer secret-B'); return { rate_limit: { primary_window: { used_percent: 12 } } };
      },
    });
    f.accounts.select('codex', a.id);
    const old = service.usage(); await oldStarted;
    f.accounts.select('codex', b.id);
    const current = await service.usage(); assert.equal(current.data?.providers[0].windows[0].usedPercent, 12);
    release(); await old;
    assert.equal((await service.usage()).data?.providers[0].windows[0].usedPercent, 12);
    assert.ok(!JSON.stringify(current).includes('secret-'));
  } finally { f.close(); }
});

test('Claude account profiles use only their own config directory', async () => {
  const f = fixture();
  try {
    const account = await f.accounts.add('claude', 'Claude account');
    assert.ok(account.loginCommand.includes('CLAUDE_CONFIG_DIR'));
    assert.ok(account.loginCommand.includes('claude auth login'));
    fs.writeFileSync(f.accounts.credentialPath('claude', account.id), JSON.stringify({ claudeAiOauth: { accessToken: 'secret-Claude' } }));
    f.accounts.select('claude', account.id);
    const profiles = await f.accounts.list('claude');
    assert.equal(profiles.find(p => p.active)?.id, account.id);
    assert.equal(profiles.find(p => p.id === account.id)?.detected, true);
    assert.ok(!JSON.stringify(profiles).includes('secret-Claude'));
  } finally { f.close(); }
});

test('Windows account setup refuses credentials storage when private ACL setup fails', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture(async (_exe, args) => ({ exitCode: args[0] === '/user' ? 0 : 1, stdout: '"user","S-1-5-21-123-456-789-1001"', stderr: '' }));
  try {
    await assert.rejects(f.accounts.add('codex', 'Unprotected'), /private account storage/);
    assert.equal(f.store.db.prepare('SELECT id FROM provider_accounts').all().length, 0);
  } finally { f.close(); }
});

test('deleting an owned profile clears its credentials and selection but preserves other profiles', async () => {
  const f = fixture();
  try {
    const a = await f.accounts.add('codex', 'Remove');
    const b = await f.accounts.add('codex', 'Keep');
    const credential = f.accounts.credentialPath('codex', a.id);
    fs.writeFileSync(credential, JSON.stringify({ tokens: { access_token: 'private' } }));
    f.accounts.select('codex', a.id);
    await assert.rejects(f.accounts.remove('claude', a.id), /Unknown/);
    await assert.rejects(f.accounts.remove('codex', 'system'), /Unknown/);
    await f.accounts.remove('codex', a.id);
    assert.equal(fs.existsSync(credential), false);
    assert.equal(f.accounts.selected('codex'), 'system');
    assert.deepEqual((await f.accounts.list('codex')).map(a => a.id), ['system', b.id]);
  } finally { f.close(); }
});

test('native sign-in uses fixed arguments and isolated credentials, completes from the exact profile only', async () => {
  const f = fixture();
  const previousHost = process.env.ADE_PTY_HOST;
  const accounts = new ProviderAccounts(f.store, defaultCommandRunner, () => ({ executable: process.execPath, args: [] }));
  try {
    const helper = path.join(f.directory, 'login-helper.cjs');
    fs.writeFileSync(helper, `const fs=require('node:fs'),path=require('node:path');process.on('message',m=>{if(m.type==='stop')process.exit(0);if(m.type==='start'){if(JSON.stringify(m.args)!=='["login"]')process.exit(2);process.send({type:'data',data:'https://auth.openai.com/authorize?test=1\\n'});setTimeout(()=>fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{access_token:'never-return-this'}})),200);}});`);
    process.env.ADE_PTY_HOST = helper;
    const account = await accounts.add('codex', 'Browser sign-in');
    await accounts.startLogin('codex', account.id);
    assert.equal((await accounts.list('codex')).find(a => a.id === account.id)?.signIn?.state, 'pending');
    const deadline = Date.now() + 5000;
    let result;
    do { await new Promise(resolve => setTimeout(resolve, 100)); result = (await accounts.list('codex')).find(a => a.id === account.id); } while (result?.signIn?.state === 'pending' && Date.now() < deadline);
    assert.equal(result?.signIn?.state, 'complete');
    assert.equal(result?.detected, true);
    assert.ok(!JSON.stringify(result).includes('never-return-this'));
    assert.equal(accounts.selected('codex'), 'system');
  } finally { accounts.close(); if (previousHost === undefined) delete process.env.ADE_PTY_HOST; else process.env.ADE_PTY_HOST = previousHost; await new Promise(resolve => setTimeout(resolve, 1200)); f.close(); }
});
