import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applySkillReference, composerEntries, composerPrefix, composerPrefixes, composerTrigger, leadingReference, skillPrefix } from '../features/workflow/composerCommands';
import { ComposerReferenceMenu } from '../features/workflow/ComposerReferenceMenu';
import type { AgentSkillSummary } from '../../shared/contracts';

const skills: AgentSkillSummary[] = [
  { name: 'animate', description: 'Build an animation from scratch', scope: 'personal' },
  { name: 'orca-cli', description: 'Operate Orca-managed worktrees', scope: 'personal' },
];

test('Codex accepts / for commands and $ for skills, while other providers use /', () => {
  assert.deepEqual(composerPrefixes('codex'), ['/', '$']);
  assert.equal(composerPrefix('codex'), '$');
  for (const provider of ['claude', 'codebuddy', 'antigravity', 'dsh', 'opencode', 'opencode2', 'kilo', 'terminal', null, undefined]) {
    assert.deepEqual(composerPrefixes(provider), ['/'], String(provider));
    assert.equal(composerPrefix(provider), '/', String(provider));
  }
});

test('only a leading prefix with a single unbroken run arms the reference menu', () => {
  assert.deepEqual(composerTrigger('/', '/'), { prefix: '/', query: '', start: 0 });
  assert.deepEqual(composerTrigger('/mod', '/'), { prefix: '/', query: 'mod', start: 0 });
  // Ordinary prose, an inline slash, pasted paths and multi-line drafts stay text.
  assert.equal(composerTrigger('hello /model', '/'), null);
  assert.equal(composerTrigger('/model choose', '/'), null);
  assert.equal(composerTrigger('C:/Users/User/file.png', '/'), null);
  assert.equal(composerTrigger('/model\nnext', '/'), null);
  assert.equal(composerTrigger('$animate', '$')?.query, 'animate');
  assert.equal(composerTrigger('$animate', '/'), null);
  // Codex accepts either prefix.
  assert.equal(composerTrigger('/model', ['/', '$'])?.prefix, '/');
  assert.equal(composerTrigger('$animate', ['/', '$'])?.prefix, '$');
});

test('commands appear only under / and skills follow them, filtered by the typed query', () => {
  const all = composerEntries(composerTrigger('/', '/')!, skills);
  assert.deepEqual(all.map(entry => entry.label), ['/context', '/model', '/effort', '/animate', '/orca-cli']);
  assert.deepEqual(all.slice(0, 3).map(entry => entry.kind), ['command', 'command', 'command']);
  const codex = composerEntries(composerTrigger('$', '$')!, skills);
  assert.deepEqual(codex.map(entry => entry.label), ['$animate', '$orca-cli']);
  assert.ok(codex.every(entry => entry.kind === 'skill'));
  // Codex `/` lists its commands and the same `$` skill tokens.
  const codexSlash = composerEntries(composerTrigger('/', ['/', '$'])!, skills, 'codex');
  assert.deepEqual(codexSlash.map(entry => entry.label), ['/context', '/model', '/effort', '$animate', '$orca-cli']);
  assert.deepEqual(composerEntries(composerTrigger('/eff', '/')!, skills).map(entry => entry.label), ['/effort']);
  assert.deepEqual(composerEntries(composerTrigger('/an', '/')!, skills).map(entry => entry.label), ['/animate']);
  // A description match is a valid reference hit.
  assert.deepEqual(composerEntries(composerTrigger('/worktree', '/')!, skills).map(entry => entry.label), ['/orca-cli']);
  assert.deepEqual(composerEntries(composerTrigger('/zzz', '/')!, skills), []);
  assert.equal(skillPrefix('codex'), '$');
  assert.equal(skillPrefix('claude'), '/');
});

test('compaction is offered only when the session reports a verified native command', () => {
  // No observed capability means the command is not offered at all.
  assert.ok(!composerEntries(composerTrigger('/', '/')!, skills, 'claude').some(entry => entry.label === '/compact'));
  const supported = composerEntries(composerTrigger('/', '/')!, skills, 'claude', { compact: true });
  assert.deepEqual(supported.map(entry => entry.label), ['/context', '/model', '/effort', '/compact', '/animate', '/orca-cli']);
  assert.deepEqual(composerEntries(composerTrigger('/comp', '/')!, skills, 'claude', { compact: true }).map(entry => entry.label), ['/compact']);
  assert.deepEqual(composerEntries(composerTrigger('/comp', '/')!, skills, 'claude', { compact: false }), []);
  // A `$` menu lists skills only, and Codex `/` still groups commands first.
  assert.deepEqual(composerEntries(composerTrigger('$', '$')!, skills, 'codex', { compact: true }).map(entry => entry.label), ['$animate', '$orca-cli']);
  assert.deepEqual(composerEntries(composerTrigger('/', ['/', '$'])!, skills, 'codex', { compact: true }).map(entry => entry.label),
    ['/context', '/model', '/effort', '/compact', '$animate', '$orca-cli']);
});

test('a chosen skill stays in the draft as the provider-native reference', () => {  assert.equal(applySkillReference('$animate'), '$animate ');
  assert.equal(applySkillReference('/orca-cli'), '/orca-cli ');
  assert.deepEqual(leadingReference('$animate build a hero', '$'), { token: '$animate', rest: 'build a hero' });
  assert.deepEqual(leadingReference('/model', '/'), { token: '/model', rest: '' });
  assert.equal(leadingReference('build a hero', '$'), null);
});

test('the reference menu renders labelled command and skill groups with one active row', () => {
  const entries = composerEntries(composerTrigger('/', '/')!, skills);
  const html = renderToStaticMarkup(createElement(ComposerReferenceMenu, { entries, activeIndex: 1, onSelect: () => {}, onHover: () => {} }));
  assert.match(html, /role="listbox"/);
  assert.match(html, /Commands/);
  assert.match(html, /Skills/);
  assert.match(html, />\/model</);
  assert.match(html, />\/animate</);
  assert.match(html, /Personal/);
  // Exactly one row is marked active, and it is the one the keyboard would choose.
  assert.equal((html.match(/data-active="true"/g) ?? []).length, 1);
  assert.match(html, /aria-selected="true"[^>]*data-active="true"|data-active="true"[^>]*aria-selected="true"/);
  const codexHtml = renderToStaticMarkup(createElement(ComposerReferenceMenu, { entries: composerEntries(composerTrigger('$', '$')!, skills), activeIndex: 0, onSelect: () => {}, onHover: () => {} }));
  assert.doesNotMatch(codexHtml, /Commands/);
  assert.match(codexHtml, />\$animate</);
  const empty = renderToStaticMarkup(createElement(ComposerReferenceMenu, { entries: [], activeIndex: -1, emptyMessage: 'No installed skills match.', onSelect: () => {}, onHover: () => {} }));
  assert.match(empty, /No installed skills match\./);
});
