import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptContextUsage, isContextRecord } from '../common/contextUsage.js';

const fold = (provider: string, ...rows: unknown[]) => transcriptContextUsage(provider, 'exact', rows.map(row => JSON.stringify(row)));
test('Claude native context command reports preserve the native estimate and window without alias guessing',()=>{
  const response={type:'assistant',sessionId:'exact',message:{role:'assistant',model:'deepseek-v4.1-flash-sg',usage:{input_tokens:219,cache_read_input_tokens:34688,output_tokens:177}}};
  const report={type:'system',subtype:'local_command',commandRun:{command:'context',args:''},sessionId:'exact',timestamp:'2026-10-28T14:10:42Z',content:'<local-command-stdout> \u001b[1mContext Usage\u001b[22m\n◉ ◉  workbuddy-ai/deepseek-v4.1-flash-sg[1m]\n◉ ◉  35.3k/272k tokens (13%)\nEstimated usage by category\nAuto-compact window: 272k tokens</local-command-stdout>'};
  const usage=fold('claude',response,report);
  // The native denominator is the auto-compact window this session runs under; a `[1m]`
  // model label describes the model window and never overrides that capacity.
  assert.equal(usage.usedTokens,35300);assert.equal(usage.windowTokens,272000);assert.equal(usage.autoCompactAtTokens,272000);assert.equal(usage.measurement,'reported');assert.equal(usage.estimated,true);
  assert.equal(usage.inputTokens,undefined,'request accounting is not mixed into a native estimate');
  assert.equal(isContextRecord(JSON.stringify(report)),true);
  for(const override of [{sessionId:'other'},{isSidechain:true},{isMeta:true},{type:'user'},{commandRun:{command:'model'}}])assert.equal(fold('claude',response,{...report,...override}).windowTokens,null);
  assert.equal(fold('claude',response,report,response).windowTokens,272000);
  assert.equal(fold('claude',response,report,{...response,message:{...response.message,model:'another'}}).windowTokens,null);
  assert.equal(fold('claude',response,report,{type:'system',subtype:'local_command',sessionId:'exact',commandRun:{command:'model'},content:'<local-command-stdout>Set model to `New model`</local-command-stdout>'}).windowTokens,null);
  assert.equal(fold('claude',response,report,{type:'system',subtype:'compact_boundary'}).usedTokens,null);
});
test('an over-limit Claude /context report still supplies the native window',()=>{
  const response={type:'assistant',sessionId:'exact',message:{role:'assistant',model:'claude-sonnet-5',usage:{input_tokens:2,cache_read_input_tokens:681861,cache_creation_input_tokens:387,output_tokens:34}}};
  const report={type:'system',subtype:'local_command',commandRun:{command:'context',args:''},sessionId:'exact',timestamp:'2026-10-29T08:17:24.461Z',
    content:'<local-command-stdout> \u001b[1mContext Usage\u001b[22m\n\u001b[38;2;255;107;128mContext is 410.3k tokens past the 272k-token compaction window — run /compact to reduce usage.\u001b[39m\n\u001b[38;2;153;153;153mworkbuddy-ai/glm-5.3-flash[1m]\u001b[39m\n\u001b[38;2;153;153;153m682.3k/272k tokens (251%)\u001b[39m\n\n\u001b[1mAuto-compact window: \u001b[22m272k tokens</local-command-stdout>'};
  const usage=fold('claude',response,report);
  assert.equal(usage.windowTokens,272000,'capacity is the auto-compact window the native report compares against');
  assert.equal(usage.autoCompactAtTokens,272000);
  assert.equal(usage.usedTokens,682300);
  assert.equal(usage.measurement,'reported');
  // The report's own model label never replaces the observed response model.
  assert.equal(usage.model,'claude-sonnet-5');
  // A bare model label reports the same denominator.
  const bare={...report,content:report.content.replace('[1m]','')};
  assert.equal(fold('claude',response,bare).windowTokens,272000);
  assert.equal(fold('claude',response,bare).autoCompactAtTokens,272000);
  // A report with only the auto-compact line still supplies the window to the response model.
  const windowOnly={...report,content:'<local-command-stdout>Context Usage\n\nAuto-compact window: 272k tokens</local-command-stdout>'};
  assert.equal(fold('claude',response,windowOnly).windowTokens,272000);
  assert.equal(fold('claude',response,windowOnly).usedTokens,682250);
});

test('Claude capacity follows the configured auto-compact window before any /context run',()=>{
  const response={type:'assistant',sessionId:'exact',timestamp:'2026-10-29T09:19:00Z',message:{role:'assistant',model:'opencode-zen/deepseek-v4.1-flash-free',usage:{input_tokens:100,cache_read_input_tokens:277700,output_tokens:10}}};
  const windows={byModel:new Map([['opencode-zen/deepseek-v4.1-flash-free',500000]]),defaultWindow:272000};
  const withSettings=transcriptContextUsage('claude','exact',[JSON.stringify(response)],{claudeAutoCompact:windows});
  assert.equal(withSettings.usedTokens,277800);
  assert.equal(withSettings.windowTokens,500000,'the model auto-compact window is the capacity');
  assert.equal(withSettings.autoCompactAtTokens,500000);
  assert.equal(withSettings.measurement,'last-request');
  // A model without its own entry follows the configured default.
  const other=transcriptContextUsage('claude','exact',[JSON.stringify({...response,message:{...response.message,model:'another-model'}})],{claudeAutoCompact:windows});
  assert.equal(other.windowTokens,272000);
  // Without any configuration an observed request window still supplies a capacity.
  const observed=transcriptContextUsage('claude','exact',[JSON.stringify({...response,message:{...response.message,usage:{...response.message.usage,contextWindow:1000000}}})],{claudeAutoCompact:{byModel:new Map(),defaultWindow:null}});
  assert.equal(observed.windowTokens,1000000);
  assert.equal(observed.autoCompactAtTokens,undefined);
  assert.equal(transcriptContextUsage('claude','exact',[JSON.stringify(response)],{claudeAutoCompact:{byModel:new Map(),defaultWindow:null}}).windowTokens,null,'no guessed model limit');
});

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
