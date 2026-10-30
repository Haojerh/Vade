import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  hashId,
  mapToState,
  normalizeLiveness,
  stripAnsi,
  toIsoOrNull,
  readBoundedTranscriptLines,
  readOlderTranscriptLines,
  getAllowedTranscriptRoots,
  isPathInsideRoots,
} from '../common/transcriptUtils.js';

test('transcript root boundaries accept equivalent Windows namespace paths without accepting siblings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-path-boundary-'));
  try {
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, '');
    assert.equal(isPathInsideRoots(path.toNamespacedPath(file), [root]), true);
    assert.equal(isPathInsideRoots(file, [path.toNamespacedPath(root)]), true);
    assert.equal(isPathInsideRoots(path.toNamespacedPath(root + '-sibling/session.jsonl'), [root]), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
import {
  readAntigravityModel,
  isAntigravityChatRecord,
} from '../antigravity/antigravity.js';

describe('server/orca/utils', () => {
  test('Antigravity recent window counts public chat turns before limiting and skips tool/thinking records', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-chat-window-'));
    const file = path.join(dir, 'transcript.jsonl');
    try {
      const records: string[] = [];
      for (let step = 0; step < 30; step++) {
        records.push(JSON.stringify({ type: step % 2 ? 'PLANNER_RESPONSE' : 'USER_INPUT', content: `Public turn ${step}` }));
        for (let tool = 0; tool < 250; tool++) {
          records.push(JSON.stringify({ type: 'PLANNER_RESPONSE', thinking: 'Internal reasoning', tool_calls: [{}] }));
        }
      }
      fs.writeFileSync(file, records.join('\n') + '\n');
      const recent = await readBoundedTranscriptLines(file, null, 20, 1024 * 1024, false, isAntigravityChatRecord);
      assert.equal(recent.lines.length, 20);
      assert.equal(JSON.parse(recent.lines[0]).content, 'Public turn 10');
      assert.equal(JSON.parse(recent.lines[19]).content, 'Public turn 29');
      assert.ok(recent.lines.every((line) => !JSON.parse(line).thinking));

      fs.appendFileSync(file, JSON.stringify({ type: 'GENERIC', content: 'Tool output' }) + '\n' +
        JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'New public reply' }) + '\n');
      const newer = await readBoundedTranscriptLines(file, recent.nextByteOffset, 20, 1024 * 1024, false, isAntigravityChatRecord);
      assert.equal(newer.lines.length, 1);
      assert.equal(JSON.parse(newer.lines[0]).content, 'New public reply');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mapToState maps known states and preserves unknowns', () => {
    assert.equal(mapToState('working'), 'working');
    assert.equal(mapToState('running'), 'working');
    assert.equal(mapToState('waiting'), 'waiting');
    assert.equal(mapToState('awaiting input'), 'waiting');
    assert.equal(mapToState('blocked'), 'blocked');
    assert.equal(mapToState('completed'), 'completed');
    assert.equal(mapToState('done'), 'completed');
    assert.equal(mapToState('succeeded'), 'completed');
    assert.equal(mapToState('failed'), 'failed');
    assert.equal(mapToState('error'), 'failed');
    assert.equal(mapToState('idle'), 'idle');
    assert.equal(mapToState('⚠ Heads up, you have less than 10% of your 5h limit left. Run /status for a breakdown.'), 'working');
    assert.equal(mapToState('custom_unexpected_status'), 'unknown');
    assert.equal(mapToState(null), 'unknown');
    assert.equal(mapToState(undefined), 'unknown');
  });

  test('stripAnsi removes escape codes and control chars', () => {
    const raw = '\x1B[32mSuccess\x1B[0m\x1B[1m Bold\x1B[0m';
    assert.equal(stripAnsi(raw), 'Success Bold');
  });

  test('toIsoOrNull enforces strict timestamp parsing and rejects ambiguous SQL timestamps', () => {
    // Valid ISO timestamps with explicit timezone
    assert.equal(toIsoOrNull('2026-10-15T09:38:45Z'), '2026-10-15T09:38:45.000Z');
    assert.equal(toIsoOrNull('2026-10-15 09:38:45+00:00'), '2026-10-15T09:38:45.000Z');
    assert.equal(toIsoOrNull('2026-10-15T09:38:45.123Z'), '2026-10-15T09:38:45.123Z');

    // Ambiguous SQL timestamps lacking timezone must return null
    assert.equal(toIsoOrNull('2026-10-15 09:38:45'), null);
    assert.equal(toIsoOrNull('2026-10-15'), null);
    assert.equal(toIsoOrNull('not-a-date'), null);

    // Number timestamp handling
    assert.equal(toIsoOrNull(1792056970487), new Date(1792056970487).toISOString());
    assert.equal(toIsoOrNull(NaN), null);
    assert.equal(toIsoOrNull(Infinity), null);
    assert.equal(toIsoOrNull(-100), null);
    assert.equal(toIsoOrNull(1e25), null);
    assert.equal(toIsoOrNull(null), null);
    assert.equal(toIsoOrNull(undefined), null);
  });

  test('normalizeLiveness preserves unverifiable and unknown verdicts (B5)', () => {
    assert.equal(normalizeLiveness('live'), 'live');
    assert.equal(normalizeLiveness('running'), 'live');
    assert.equal(normalizeLiveness('⚠ Heads up, you have less than 10% of your 5h limit left. Run /status for a breakdown.'), 'live');
    assert.equal(normalizeLiveness('exited'), 'exited');
    assert.equal(normalizeLiveness('dead'), 'exited');
    assert.equal(normalizeLiveness('unverifiable'), 'unverifiable');
    assert.equal(normalizeLiveness('UNVERIFIABLE'), 'unverifiable');
    assert.equal(normalizeLiveness('unknown'), 'unknown');
    assert.equal(normalizeLiveness('UNKNOWN'), 'unknown');
    assert.equal(normalizeLiveness('something-else'), 'unknown');
    assert.equal(normalizeLiveness(null), 'unknown');
  });

  test('readBoundedTranscriptLines streams and bounds file reads with limit and maxWindow', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bounded-read-'));
    const testFile = path.join(tempDir, 'test_lines.jsonl');
    const lines = Array.from({ length: 15 }, (_, i) => JSON.stringify({ index: i, msg: `Message ${i}` }));
    fs.writeFileSync(testFile, lines.join('\n'));

    try {
      // 1. First page: start 0, limit 5
      const page1 = await readBoundedTranscriptLines(testFile, 0, 5);
      assert.equal(page1.lines.length, 5);
      assert.equal(page1.hasMore, true);
      assert.equal(page1.limited, false);
      assert.equal(JSON.parse(page1.lines[0]).index, 0);
      assert.equal(JSON.parse(page1.lines[4]).index, 4);
      assert.ok(page1.nextByteOffset > 0);

      // 2. Second page: advance with nextByteOffset, limit 5
      const page2 = await readBoundedTranscriptLines(testFile, page1.nextByteOffset, 5);
      assert.equal(page2.lines.length, 5);
      assert.equal(page2.hasMore, true);
      assert.equal(page2.limited, false);
      assert.equal(JSON.parse(page2.lines[0]).index, 5);
      assert.equal(JSON.parse(page2.lines[4]).index, 9);

      // 3. Third page: advance with nextByteOffset, limit 5
      const page3 = await readBoundedTranscriptLines(testFile, page2.nextByteOffset, 5);
      assert.equal(page3.lines.length, 5);
      assert.equal(page3.hasMore, false);
      assert.equal(page3.limited, false);
      assert.equal(JSON.parse(page3.lines[0]).index, 10);
      assert.equal(JSON.parse(page3.lines[4]).index, 14);

      // 4. Max byte window exceeded: maxBytesWindow 100 bytes
      const bounded = await readBoundedTranscriptLines(testFile, 0, 10, 100);
      assert.equal(bounded.limited, true);
      assert.equal(bounded.hasMore, true);
      assert.ok(bounded.lines.length < 10 && bounded.lines.length > 0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('readBoundedTranscriptLines handles huge single line (>2MB) without unbounded IO or OOM', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-huge-line-'));
    const testFile = path.join(tempDir, 'huge.jsonl');
    const hugeLine = JSON.stringify({ huge: 'x'.repeat(2 * 1024 * 1024) }) + '\n';
    const normalLine = JSON.stringify({ step: 1, text: 'hello after huge' }) + '\n';
    fs.writeFileSync(testFile, hugeLine + normalLine);

    try {
      // 1. Read with standard 512KiB window: giant line exceeds window, advances boundedly with seekingNewline: true
      let offset = 0;
      let seeking = false;
      let iterations = 0;
      let res: any;
      while (iterations < 10) {
        iterations++;
        res = await readBoundedTranscriptLines(testFile, offset, 10, 512 * 1024, seeking);
        assert.equal(res.lines.length, 0, 'Giant line exceeding maxBytesWindow must not be truncated into partial records');
        assert.equal(res.limited, true);
        assert.equal(res.hasMore, true);
        offset = res.nextByteOffset;
        seeking = Boolean(res.seekingNewline);
        if (!seeking) break;
      }
      assert.ok(res.nextByteOffset > 2 * 1024 * 1024, 'nextByteOffset must advance past giant line');

      // 2. Next continuation read from nextByteOffset must read normal records
      const res2 = await readBoundedTranscriptLines(testFile, res.nextByteOffset, 10, 512 * 1024);
      assert.equal(res2.lines.length, 1);
      assert.equal(JSON.parse(res2.lines[0]).step, 1);
      assert.equal(JSON.parse(res2.lines[0]).text, 'hello after huge');
      assert.equal(res2.hasMore, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('readBoundedTranscriptLines handles >10,000 records with recent initial tail and continuation advances', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-10k-records-'));
    const testFile = path.join(tempDir, '10k.jsonl');
    const lines10k = Array.from({ length: 12000 }, (_, i) => JSON.stringify({ step: i, msg: `Record ${i}` }) + '\n');
    fs.writeFileSync(testFile, lines10k.join(''));

    try {
      // 1. Initial read without cursor (null/undefined): must read recent TAIL, not oldest records at byte 0
      const initTail = await readBoundedTranscriptLines(testFile, null, 100);
      assert.equal(initTail.lines.length, 100);
      assert.equal(initTail.hasMore, false);
      assert.equal(initTail.limited, true);
      const lastRecord = JSON.parse(initTail.lines[initTail.lines.length - 1]);
      assert.equal(lastRecord.step, 11999, 'Initial read must capture recent tail records');
      const firstTailRecord = JSON.parse(initTail.lines[0]);
      assert.ok(firstTailRecord.step > 5000, 'Initial read must never start from oldest records at byte 0');

      // 2. Continuation advances starting from byte 0: page 1
      const cont1 = await readBoundedTranscriptLines(testFile, 0, 100);
      assert.equal(cont1.lines.length, 100);
      assert.equal(cont1.hasMore, true);
      assert.equal(JSON.parse(cont1.lines[0]).step, 0);
      assert.equal(JSON.parse(cont1.lines[99]).step, 99);
      assert.ok(cont1.nextByteOffset > 0);

      // 3. Continuation advances to page 2 using nextByteOffset
      const cont2 = await readBoundedTranscriptLines(testFile, cont1.nextByteOffset, 100);
      assert.equal(cont2.lines.length, 100);
      assert.equal(cont2.hasMore, true);
      assert.equal(JSON.parse(cont2.lines[0]).step, 100);
      assert.equal(JSON.parse(cont2.lines[99]).step, 199);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('readBoundedTranscriptLines handles append and newline split without truncating incomplete records', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-append-split-'));
    const testFile = path.join(tempDir, 'append.jsonl');
    fs.writeFileSync(testFile, '{"step":0}\n{"step":1}\n{"step":2,"partia');

    try {
      // 1. Incomplete record at EOF is discarded from lines; nextByteOffset points before it
      const res1 = await readBoundedTranscriptLines(testFile, 0, 10);
      assert.equal(res1.lines.length, 2);
      assert.equal(JSON.parse(res1.lines[0]).step, 0);
      assert.equal(JSON.parse(res1.lines[1]).step, 1);

      // 2. Complete the write by appending the remainder and newline
      fs.appendFileSync(testFile, 'l":false}\n');

      // 3. Reading from nextByteOffset seamlessly recovers step 2
      const res2 = await readBoundedTranscriptLines(testFile, res1.nextByteOffset, 10);
      assert.equal(res2.lines.length, 1);
      assert.equal(JSON.parse(res2.lines[0]).step, 2);
      assert.equal(JSON.parse(res2.lines[0]).partial, false);
      assert.equal(res2.hasMore, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('isPathInsideRoots enforces canonical realpath and prevents symlink traversal escapes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-symlink-test-'));
    const allowedRoot = path.join(tempDir, 'allowed');
    const secretDir = path.join(tempDir, 'secret');
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(secretDir, { recursive: true });

    const secretFile = path.join(secretDir, 'secret.jsonl');
    fs.writeFileSync(secretFile, '{"secret":true}\n');

    const linkPath = path.join(allowedRoot, 'escaped-link.jsonl');
    try {
      try {
        fs.symlinkSync(secretFile, linkPath);
      } catch {
        // Fallback for Windows environments without symlink privilege: junction or skip
      }

      // 1. Normal file inside allowed root: allowed
      const normalFile = path.join(allowedRoot, 'normal.jsonl');
      fs.writeFileSync(normalFile, '{"normal":true}\n');
      assert.equal(isPathInsideRoots(normalFile, [allowedRoot]), true);

      // 2. Secret file outside allowed root: rejected
      assert.equal(isPathInsideRoots(secretFile, [allowedRoot]), false);

      // 3. Symlink pointing outside allowed root: canonical realpath points to secretDir, must be rejected
      if (fs.existsSync(linkPath)) {
        assert.equal(isPathInsideRoots(linkPath, [allowedRoot]), false);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('getAllowedTranscriptRoots excludes os.tmpdir from production roots', () => {
    const roots = getAllowedTranscriptRoots();
    assert.equal(roots.includes(os.tmpdir()), false);
  });

  test('readBoundedTranscriptLines strictly caps total bytes read per call to maxBytesWindow + 64KiB and handles huge no-newline tail', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-bounded-read-cap-'));
    const testFile = path.join(tempDir, 'cap.jsonl');
    const hugeLine = JSON.stringify({ huge: 'y'.repeat(2 * 1024 * 1024) }) + '\n';
    const normalLine = JSON.stringify({ step: 99, text: 'normal record' }) + '\n';
    fs.writeFileSync(testFile, hugeLine + normalLine);

    const origReadSync = fs.readSync;
    let bytesReadInCurrentCall = 0;
    fs.readSync = function (this: any, ...args: any[]) {
      const length = args[3];
      bytesReadInCurrentCall += length;
      return (origReadSync as any).apply(this, args);
    } as any;

    try {
      const windowSize = 512 * 1024;
      const cap = windowSize + 64 * 1024;

      // 1. Initial read on giant line: bytes read must not exceed cap
      bytesReadInCurrentCall = 0;
      const res1 = await readBoundedTranscriptLines(testFile, 0, 10, windowSize, false);
      assert.ok(
        bytesReadInCurrentCall <= cap,
        `Read per call (${bytesReadInCurrentCall}) must not exceed maxBytesWindow + 64KiB (${cap})`
      );
      assert.equal(res1.lines.length, 0);
      assert.equal(res1.limited, true);
      assert.equal(res1.hasMore, true);
      assert.equal(res1.seekingNewline, true);
      assert.ok(res1.nextByteOffset > 0 && res1.nextByteOffset <= cap);

      // 2. Subsequent continuation reads with seekingNewline: each call must respect cap
      let offset = res1.nextByteOffset;
      let seeking = Boolean(res1.seekingNewline);
      let res = res1;
      while (seeking) {
        bytesReadInCurrentCall = 0;
        res = await readBoundedTranscriptLines(testFile, offset, 10, windowSize, seeking);
        assert.ok(
          bytesReadInCurrentCall <= cap,
          `Continuation read per call (${bytesReadInCurrentCall}) must not exceed cap (${cap})`
        );
        offset = res.nextByteOffset;
        seeking = Boolean(res.seekingNewline);
      }
      assert.equal(seeking, false);
      assert.ok(res.nextByteOffset > 2 * 1024 * 1024);

      // 3. Resumes at newline: reading from offset yields normal line cleanly
      bytesReadInCurrentCall = 0;
      const normalRes = await readBoundedTranscriptLines(testFile, res.nextByteOffset, 10, windowSize, false);
      assert.equal(normalRes.lines.length, 1);
      assert.equal(JSON.parse(normalRes.lines[0]).step, 99);

      // 4. Initial read with huge no-newline tail: yields limited: true, progressing offset, seekingNewline: true
      const hugeTailFile = path.join(tempDir, 'huge-tail.jsonl');
      fs.writeFileSync(hugeTailFile, 'x'.repeat(2 * 1024 * 1024));
      bytesReadInCurrentCall = 0;
      const tailRes = await readBoundedTranscriptLines(hugeTailFile, null, 10, windowSize);
      assert.ok(bytesReadInCurrentCall <= cap);
      assert.equal(tailRes.lines.length, 0, 'No malformed line on huge no-newline tail');
      assert.equal(tailRes.limited, true);
      assert.equal(tailRes.seekingNewline, true);
      assert.ok(tailRes.nextByteOffset > 0, 'Progressing offset on huge tail');
    } finally {
      fs.readSync = origReadSync;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('older transcript pages traverse all public turns in batches without duplicates or private records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-older-pages-'));
  const file = path.join(dir, 'turns.jsonl');
  try {
    fs.writeFileSync(file, Array.from({ length: 45 }, (_, index) => [
      JSON.stringify({ kind: 'public', text: `Message ${index} � hello` }),
      JSON.stringify({ kind: 'thinking', text: 'Private' }),
    ]).flat().join('\n'));
    let cursor: number | null = null;
    let all: number[] = [];
    let pages = 0;
    do {
      const page = await readOlderTranscriptLines(file, cursor, 20, 8 * 1024 * 1024, false, line => JSON.parse(line).kind === 'public');
      assert.ok(page.lines.length <= 20);
      all = [...page.lines.map(line => Number(JSON.parse(line).text.match(/Message (\d+)/)[1])), ...all];
      if (cursor !== null) assert.ok(page.nextByteOffset < cursor);
      cursor = page.nextByteOffset;
      pages++;
      if (!page.hasMore) break;
      assert.ok(pages < 5);
    } while (true);
    assert.equal(pages, 3);
    assert.deepEqual(all, Array.from({ length: 45 }, (_, index) => index));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
