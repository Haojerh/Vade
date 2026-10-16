import type { Progress, Task } from '../../shared/contracts.js';

export function taskProgress(tasks: Task[], coverage: Progress['coverage']): Progress {
  const counts = { completed: 0, failed: 0, working: 0, waiting: 0, blocked: 0, unknown: 0 };
  for (const task of tasks) {
    if (task.state in counts) counts[task.state as keyof typeof counts]++;
    else counts.unknown++;
  }
  return {
    total: tasks.length, ...counts,
    percent: coverage === 'complete' && tasks.length > 0 && counts.unknown === 0
      ? Math.floor(counts.completed / tasks.length * 100) : null,
    coverage, basis: 'completed-tasks',
  };
}
