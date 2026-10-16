import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskProgress } from './progress.js';
import type { Task } from '../../shared/contracts.js';

const tasks = (...states: Task['state'][]) => states.map((state) => ({ state }) as Task);

test('task completion counts successful tasks only and includes all tasks in the denominator', () => {
  const progress = taskProgress(tasks('completed', 'working', 'failed', 'waiting'), 'complete');
  assert.equal(progress.percent, 25);
  assert.equal(progress.total, 4);
  assert.equal(progress.failed, 1);
  assert.equal(taskProgress(tasks('completed', 'completed'), 'complete').percent, 100);
});

test('missing, truncated, empty, and unknown task evidence cannot produce a verified percentage', () => {
  assert.equal(taskProgress(tasks('completed'), 'partial').percent, null);
  assert.equal(taskProgress([], 'unavailable').percent, null);
  assert.equal(taskProgress([], 'complete').percent, null);
  assert.equal(taskProgress(tasks('completed', 'unknown'), 'complete').percent, null);
});
