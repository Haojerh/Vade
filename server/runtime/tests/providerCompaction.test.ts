import test from 'node:test';
import assert from 'node:assert/strict';
import { compactCommand, compactionOutcome, compactionSignals } from '../chat/controls/providerCompaction.js';

test('only providers with a verified native compaction command are supported', () => {
  for (const provider of ['claude', 'codex', 'codebuddy', 'antigravity', 'opencode', 'opencode2', 'kilo', 'kilocode', 'dsh']) {
    assert.equal(compactCommand(provider), '/compact', provider);
  }
  for (const provider of ['terminal', 'pi', 'omp', 'freebuff', 'unknown', '']) {
    assert.equal(compactCommand(provider), null, provider);
  }
  // Object prototype keys never resolve to a command.
  assert.equal(compactCommand('constructor'), null);
  assert.equal(compactCommand('__proto__'), null);
});

test('a new native compaction acknowledgement confirms, silence and echoes stay pending', () => {
  // Exact strings observed in the installed CLIs.
  const claudeBefore = '$ 12k tokens left\n> ';
  const claudeAfter = '$ 12k tokens left\n> /compact\n  Compacting conversation…';
  assert.equal(compactionOutcome({ fresh: ' Compacting conversation…', before: claudeBefore, after: claudeAfter }), 'confirmed');
  assert.equal(compactionOutcome({ fresh: 'Compacting context', before: 'Context left: 90%', after: 'Context left: 90%\nCompacting context' }), 'confirmed');
  assert.equal(compactionOutcome({ fresh: 'Context compacted', before: '', after: 'Context compacted' }), 'confirmed');
  // The echoed command alone is not evidence.
  assert.equal(compactionOutcome({ fresh: '> /compact', before: '> ', after: '> /compact' }), 'pending');
  assert.equal(compactionOutcome({ fresh: '', before: '> ', after: '> ' }), 'pending');
  // A stale acknowledgement already on screen does not confirm a new request.
  assert.equal(compactionOutcome({ fresh: '> /compact', before: 'Compacting context', after: 'Compacting context\n> /compact' }), 'pending');
  // Ordinary prose about compaction is not an acknowledgement.
  assert.equal(compactionSignals('Context is past the compaction window — run /compact'), 0);
  assert.equal(compactionSignals('Compacting conversation'), 1);
  assert.equal(compactionSignals('compacted'), 1);
});

test('a native rejection is reported instead of waiting out the confirmation window', () => {
  assert.equal(compactionOutcome({ fresh: 'Unknown command: /compact', before: '> ', after: 'Unknown command: /compact' }), 'rejected');
  assert.equal(compactionOutcome({ fresh: 'invalid slash command', before: '', after: 'invalid slash command' }), 'rejected');
  // An older rejection still on screen does not label the new attempt.
  assert.equal(compactionOutcome({ fresh: '> /compact', before: 'Unknown command: /compact', after: 'Unknown command: /compact\n> /compact' }), 'pending');
});
