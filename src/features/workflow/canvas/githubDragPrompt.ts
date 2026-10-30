export interface DraggedGitHubItem {
  type: 'pr' | 'issue';
  number: number;
  title: string;
  url?: string;
  headRef?: string | null;
  baseRef?: string | null;
  author?: string | null;
  draft?: boolean;
  labels?: string[];
}

export function buildGitHubPrompt(item: DraggedGitHubItem): string {
  if (item.type === 'pr') {
    const lines = [
      `Please review and merge Pull Request #${item.number}: "${item.title}"`,
      '',
      'Context:',
      item.url ? `- Link: ${item.url}` : null,
      item.headRef ? `- Branch: \`${item.headRef}\`${item.baseRef ? ` -> \`${item.baseRef}\`` : ''}` : null,
      item.author ? `- Author: @${item.author}` : null,
      item.draft ? '- Status: Draft' : '- Status: Ready for review',
      '',
      'Instructions:',
      '1. Review the changes and diff against the target branch.',
      '2. Run tests to ensure build and test suite pass without regressions.',
      '3. Merge the PR if sound, or report any requested revisions.',
    ].filter((line): line is string => line !== null);

    return lines.join('\n');
  }

  const lines = [
    `Please investigate and fix Issue #${item.number}: "${item.title}"`,
    '',
    'Context:',
    item.url ? `- Link: ${item.url}` : null,
    item.author ? `- Reported by: @${item.author}` : null,
    item.labels && item.labels.length > 0 ? `- Labels: ${item.labels.join(', ')}` : null,
    '',
    'Instructions:',
    '1. Locate the source code related to the issue and reproduce if needed.',
    '2. Implement a fix following existing project architecture and conventions.',
    '3. Add test coverage and verify all tests pass before completing.',
  ].filter((line): line is string => line !== null);

  return lines.join('\n');
}
