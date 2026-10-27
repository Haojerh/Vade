import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptContextUsage } from './contextUsage.js';

const fold = (provider: string, ...rows: unknown[]) => transcriptContextUsage(provider, 'exact', rows.map(row => JSON.stringify(row)));
test('Codex context uses the latest request total, never cumulative spend, and resets on model changes', () => {
  const usage = { type: 'event_msg', timestamp: '2026-10-27T12:00:00Z', payload: { type: 'token_count', info: { model_context_window: 258400, total_token_usage: { total_tokens: 900000 }, last_token_usage: { total_tokens: 25100, input_tokens: 25000, cached_input_tokens: 20000, output_tokens: 100 } } } };
  assert.equal(fold('codex', usage).usedTokens, 25100);
  assert.equal(fold('codex', usage).windowTokens, 258400);
  assert.equal(fold('codex', usage).cacheReadTokens, 20000);
  assert.equal(fold('codex', { type: 'turn_context', payload: { model: 'old' } }, usage, { type: 'turn_context', payload: { model: 'new' } }).usedTokens, null);
  assert.equal(fold('codex', usage, { type: 'compacted' }).windowTokens, null);
  assert.equal(fold('codex', { ...usage, sessionId: 'other' }).usedTokens, null);
  assert.equal(fold('codex', { ...usage, payload: { ...usage.payload, info: { model_context_window: -1, last_token_usage: { total_tokens: '123' } } } }).usedTokens, null);
});

test('Claude and CodeBuddy preserve their different cache accounting and exclude synthetic and child usage', () => {
  const claude = { type: 'assistant', sessionId: 'exact', timestamp: '2026-10-27T12:00:00Z', message: { role: 'assistant', model: 'claude-model', usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 50, output_tokens: 20 } } };
  assert.equal(fold('claude', claude).usedTokens, 350);
  assert.equal(fold('claude', { ...claude, isSidechain: true }).usedTokens, null);
  assert.equal(fold('claude', { ...claude, message: { ...claude.message, model: '<synthetic>' } }).usedTokens, null);
  assert.equal(fold('claude', claude, { type: 'system', subtype: 'compact_boundary' }).usedTokens, null);
  const buddy = { type: 'message', role: 'assistant', sessionId: 'exact', providerData: { usage: { inputTokens: 350, cacheReadTokens: 200, outputTokens: 20 } } };
  assert.equal(fold('codebuddy', buddy).usedTokens, 350);
  assert.equal(fold('codebuddy', buddy).windowTokens, null);
  assert.equal(fold('codebuddy', { ...buddy, _fromSubAgent: true }).usedTokens, null);
  assert.equal(fold('codebuddy', { ...buddy, providerData: { ...buddy.providerData, skipRun: true } }).usedTokens, null);
});

test('DSH reports bounded native context and an explicit unknown clears older usage', () => {
  const measured = { type: 'context_usage', timestamp: '2026-10-27T12:00:00Z', payload: { usedTokens: 24000, windowTokens: 1000000, inputTokens: 4000, cacheReadTokens: 20000 } };
  assert.equal(fold('dsh', measured).usedTokens, 24000);
  assert.equal(fold('dsh', measured, { type: 'context_usage', payload: { usedTokens: null, windowTokens: null } }).usedTokens, null);
  assert.equal(fold('dsh', { ...measured, payload: { usedTokens: Infinity, windowTokens: -1 } }).windowTokens, null);
});

test('CodeBuddy recorded native context reports supply model-bound capacity without trusting ordinary chat or other sessions', () => {
  const report={type:'message',role:'user',sessionId:'exact',providerData:{skipRun:true},content:[{type:'input_text',text:'<local-command-stdout>Context Usage\n deepseek-v4.1-flash · 32.5k/300k tokens (11%)\nEstimated usage by category</local-command-stdout>'}]};
  assert.equal(fold('codebuddy',report).windowTokens,300000);
  assert.equal(fold('codebuddy',report).usedTokens,32500);
  assert.equal(fold('codebuddy',{...report,providerData:{}}).windowTokens,null);
  assert.equal(fold('codebuddy',{...report,sessionId:'other'}).windowTokens,null);
  const response={type:'message',role:'assistant',sessionId:'exact',providerData:{model:'deepseek-v4.1-flash',usage:{inputTokens:35000,outputTokens:10}}};
  assert.equal(fold('codebuddy',report,response).usedTokens,35000);
  assert.equal(fold('codebuddy',report,response).windowTokens,300000);
  assert.equal(fold('codebuddy',report,{...response,providerData:{...response.providerData,model:'another-model'}}).windowTokens,null);
});
