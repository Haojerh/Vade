import test from 'node:test';
import assert from 'node:assert/strict';
import {
  freebuffContextWindow,
  freebuffModelByLabel,
  freebuffModelInRow,
  freebuffModelsFromCatalog,
  freebuffResolveStored,
  freebuffWorkflowModels,
} from '../freebuff/freebuffCatalog.js';

const live = {
  protocol: 1,
  version: 'v0.test',
  issuedAt: 1,
  refreshAt: 2,
  recommendedKey: 'm-096e75164d',
  fallbackKey: 'm-00032eaeec',
  plansUrl: 'https://example.test/plans',
  sections: [{ id: 'standard' }, { id: 'premium' }, { id: 'powerful' }],
  rows: [
    { key: 'm-6adcd6d671', displayName: 'GPT-6.1 Sol', tagline: 'OpenAI flagship', access: 'locked', efforts: ['low', 'medium', 'high'], placement: { section: 'powerful', order: 50 } },
    { key: 'm-7e20df6765', displayName: 'GLM 5.3 Flash', tagline: 'Deep reasoning', access: 'open', efforts: ['low', 'high'], defaultEffort: 'high', contextWindow: 1000000, placement: { section: 'premium', order: 10 } },
    { key: 'm-096e75164d', displayName: 'DeepSeek V4.1 Flash 10/17', tagline: 'Smart & Fast', access: 'open', efforts: ['low', 'high', 'max'], contextWindow: 1048576, placement: { section: 'premium', order: 3 } },
    { key: 'm-02244092cb', displayName: 'Glyph Cluster', tagline: 'Balanced', access: 'open', placement: { section: 'standard', order: 5 } },
    { key: 'm-7e20df6765', displayName: 'Duplicate row', access: 'open', placement: { section: 'standard', order: 1 } },
    { displayName: 'No key', access: 'open' },
  ],
};

test('the live catalog is mapped from the provider response, never a bundled snapshot', () => {
  const models = freebuffModelsFromCatalog(live);
  assert.deepEqual(models.map(model => model.id), ['m-02244092cb', 'm-096e75164d', 'm-7e20df6765']);
  assert.deepEqual(models.map(model => model.label), ['Glyph Cluster', 'DeepSeek V4.1 Flash 10/17', 'GLM 5.3 Flash']);
  // Subscription-only rows cannot be selected, so they are not offered.
  assert.equal(models.some(model => model.label === 'GPT-6.1 Sol'), false);
  // Duplicates and rows without a native key are dropped; tagline, efforts and window survive.
  const deepseek = models.find(model => model.id === 'm-096e75164d')!;
  assert.equal(deepseek.description, 'Smart & Fast');
  assert.equal(deepseek.contextWindow, 1048576);
  assert.deepEqual(deepseek.efforts.map(effort => effort.value), ['low', 'high', 'max']);
  assert.deepEqual(models.find(model => model.id === 'm-02244092cb')!.efforts, []);
});

test('an unusable catalog response yields no invented models', () => {
  assert.deepEqual(freebuffModelsFromCatalog(null), []);
  assert.deepEqual(freebuffModelsFromCatalog({ rows: 'nope' }), []);
  assert.deepEqual(freebuffModelsFromCatalog({ rows: [{ key: 'k', displayName: '', access: 'open' }] }), []);
});

test('a stored legacy id resolves to the current catalog key through its display name', () => {
  const models = freebuffModelsFromCatalog(live);
  assert.equal(freebuffResolveStored('deepseek/deepseek-v4-flash', models)?.id, 'm-096e75164d');
  assert.equal(freebuffResolveStored('m-7e20df6765', models)?.id, 'm-7e20df6765');
  assert.equal(freebuffResolveStored('DeepSeek V4.1 Flash 10/17', models)?.id, 'm-096e75164d');
  assert.equal(freebuffResolveStored('unknown/model', models), undefined);
});

test('a version-dated label still resolves, and picker rows match the longest label', () => {
  const models = freebuffModelsFromCatalog(live);
  assert.equal(freebuffModelByLabel('DeepSeek V4.1 Flash', models)?.id, 'm-096e75164d');
  assert.equal(freebuffModelByLabel('deepseek v4.1 flash 10/17', models)?.id, 'm-096e75164d');
  assert.equal(freebuffModelInRow('DeepSeek V4.1 Flash 10/17 • high · Smart & Fast · Images', models)?.id, 'm-096e75164d');
  assert.equal(freebuffModelInRow('  MiMo v2.6 Flash Fast · Balanced', models), undefined);
  assert.equal(freebuffModelInRow('OPTIMIZED · Strongest price-to-performance models', models), undefined);
  // A display name containing " · " is matched whole rather than truncated at the tagline.
  const dotted = [{ id: 'm-claude', label: 'Claude Haiku 5.5 · 100k context', efforts: [] }];
  assert.equal(freebuffModelInRow('Claude Haiku 5.5 · 100k context · low · Paid plan', dotted)?.id, 'm-claude');
});

test('context windows and workflow efforts come from the rows the account received', () => {
  const models = freebuffModelsFromCatalog(live);
  assert.equal(freebuffContextWindow('m-7e20df6765', models), 1000000);
  assert.equal(freebuffContextWindow('m-02244092cb', models), undefined);
  assert.deepEqual(freebuffWorkflowModels(models).find(model => model.id === 'm-096e75164d'), {
    id: 'm-096e75164d', label: 'DeepSeek V4.1 Flash 10/17', efforts: ['low', 'high', 'max'], contextWindow: 1048576,
  });
});
