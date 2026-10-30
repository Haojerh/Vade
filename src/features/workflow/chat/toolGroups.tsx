import type { ConversationMessage, ToolActivity } from '../../../../shared/contracts';
import { Disclosure } from '../../../components/ui/Disclosure';
import { Icon, type IconName } from '../../../components/ui/Icon';
import { ConversationToolCall } from './ConversationToolCall';

export type ToolCategory = 'run' | 'edit' | 'read' | 'search' | 'list' | 'web' | 'mcp' | 'agent' | 'plan' | 'other';

export interface ToolGroupClause {
  category: ToolCategory;
  count: number;
  text: string;
}

export interface TimelineItem {
  id: string;
  at: string | null;
  message: ConversationMessage | null;
  tool: ToolActivity | null;
}

export type ConversationTimelineEntry =
  | { kind: 'message'; id: string; at: string | null; message: ConversationMessage }
  | { kind: 'tools'; id: string; at: string | null; tools: ToolActivity[] };

const CATEGORY_ICONS: Record<ToolCategory, IconName> = {
  run: 'terminal',
  edit: 'file-edit',
  read: 'file-text',
  list: 'folder',
  search: 'search',
  web: 'globe',
  mcp: 'plug',
  agent: 'users',
  plan: 'list-checks',
  other: 'wrench',
};

function splitToolLabel(label: string): { action: string; target: string } {
  const separator = label.indexOf(': ');
  if (separator < 0) return { action: label.trim(), target: '' };
  return {
    action: label.slice(0, separator).trim(),
    target: label.slice(separator + 2).trim(),
  };
}

export function classifyToolActivity(tool: ToolActivity): ToolCategory {
  const { action } = splitToolLabel(tool.label);
  if (tool.label.startsWith('Edit') || (tool.edits?.length ?? 0) > 0 || /^(?:edit|write|patch|replace|diff|apply_patch|multi_edit|edit_file|write_file|create_file|replace_file_content|multi_replace_file_content)$/i.test(action)) return 'edit';
  if (/^(?:read|view|cat|read_file|view_file)$/i.test(action) || /\b(?:read|view)\b/i.test(action)) return 'read';
  if (/^(?:list|ls|dir|list_dir|list_files|list_directory|listdir)$/i.test(action)) return 'list';
  if (/\b(?:run|exec|shell|terminal|bash|command)\b/i.test(action)) return 'run';
  if (/\b(?:web|browse|browser|fetch)\b/i.test(action)) return 'web';
  if (/\b(?:search|find|grep|glob|rg|ripgrep)\b/i.test(action)) return 'search';
  if (/^mcp(?:__|:|\b)/i.test(action)) return 'mcp';
  if (/^(?:agent|task|subagent|invoke_subagent|spawn_agent)$/i.test(action)) return 'agent';
  if (/^(?:todowrite|todo_write|update_plan|plan)$/i.test(action)) return 'plan';
  return 'other';
}

function recordedTargets(tool: ToolActivity, category: ToolCategory): string[] {
  if (category === 'edit' && tool.edits?.length) {
    const paths = tool.edits.map(edit => edit.path.trim()).filter(Boolean);
    if (paths.length) return paths;
  }
  if (category === 'edit' || category === 'read' || category === 'list') {
    const { target } = splitToolLabel(tool.label);
    return target ? [target] : [];
  }
  return [];
}

/** Format recorded tool invocation / target counts. Verb phrasing describes recorded
 *  tool calls and targets only and never implies tool execution succeeded. */
export function formatToolClause(category: ToolCategory, count: number, verifiedTargets = true): string {
  const one = count === 1;
  if (!verifiedTargets) {
    switch (category) {
      case 'edit': return one ? '1 edit call' : `${count} edit calls`;
      case 'read': return one ? '1 read call' : `${count} read calls`;
      case 'list': return one ? '1 list call' : `${count} list calls`;
      default: break;
    }
  }
  switch (category) {
    case 'run': return one ? 'Ran 1 command' : `Ran ${count} commands`;
    case 'edit': return one ? 'Edited 1 file' : `Edited ${count} files`;
    case 'read': return one ? 'Read 1 file' : `Read ${count} files`;
    case 'search': return one ? 'Searched 1 time' : `Searched ${count} times`;
    case 'list': return one ? 'Listed 1 directory' : `Listed ${count} directories`;
    case 'web': return one ? 'Searched the web 1 time' : `Searched the web ${count} times`;
    case 'mcp': return one ? 'Used 1 integration' : `Used ${count} integrations`;
    case 'agent': return one ? 'Ran 1 agent' : `Ran ${count} agents`;
    case 'plan': return one ? 'Updated the plan' : `Updated the plan ${count} times`;
    case 'other': return one ? 'Used 1 tool' : `Used ${count} tools`;
  }
}

/** Summarize categories in first-seen chronological order. File/directory categories
 *  deduplicate recorded paths across the whole group and fall back to call counts when
 *  any call in that category lacks a recorded target path. */
export function toolGroupClauses(tools: readonly ToolActivity[]): ToolGroupClause[] {
  const buckets = new Map<ToolCategory, { calls: number; targets: Set<string>; missingTarget: boolean }>();
  for (const tool of tools) {
    const category = classifyToolActivity(tool);
    let bucket = buckets.get(category);
    if (!bucket) {
      bucket = { calls: 0, targets: new Set<string>(), missingTarget: false };
      buckets.set(category, bucket);
    }
    bucket.calls++;
    if (category === 'edit' || category === 'read' || category === 'list') {
      const targets = recordedTargets(tool, category);
      if (!targets.length) bucket.missingTarget = true;
      else for (const target of targets) bucket.targets.add(target);
    }
  }
  return [...buckets.entries()].map(([category, bucket]) => {
    const usesTargets = (category === 'edit' || category === 'read' || category === 'list') && !bucket.missingTarget && bucket.targets.size > 0;
    const verifiedTargets = !(category === 'edit' || category === 'read' || category === 'list') || usesTargets;
    const count = usesTargets ? bucket.targets.size : bucket.calls;
    return {
      category,
      count,
      text: formatToolClause(category, count, verifiedTargets),
    };
  });
}

export function summarizeToolGroup(tools: readonly ToolActivity[]): string {
  const clauses = toolGroupClauses(tools);
  return clauses.length ? clauses.map(clause => clause.text).join(', ') : 'Tool activity';
}

export function toolGroupIcon(tools: readonly ToolActivity[]): IconName {
  const clauses = toolGroupClauses(tools);
  return clauses.length === 1 ? CATEGORY_ICONS[clauses[0].category] : 'wrench';
}

/** Merge public turns and observed tool calls into one chronological timeline. Kept here so
 *  the pure ordering rules stay with the grouping they feed, and lightweight consumers do not
 *  pull in the lazy chat module. */
export function conversationTimeline(messages: ConversationMessage[], tools: ToolActivity[], limited: boolean): TimelineItem[] {
  const first = messages.find(message => message.at)?.at;
  const cutoff = limited && first ? Date.parse(first) : -Infinity;
  const items = [...messages.map(message => ({ id: message.id, at: message.at, message, tool: null as ToolActivity | null })),
    ...tools.filter(tool => !tool.at || Date.parse(tool.at) >= cutoff).map(tool => ({ id: tool.id, at: tool.at, message: null as ConversationMessage | null, tool }))];
  return items.sort((a, b) => (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity));
}

/** Group only consecutive tool calls between public messages, preserving chronological order and provenance. */
export function groupConversationTimeline(timeline: readonly TimelineItem[]): ConversationTimelineEntry[] {
  const entries: ConversationTimelineEntry[] = [];
  for (const item of timeline) {
    if (item.tool) {
      const previous = entries[entries.length - 1];
      if (previous?.kind === 'tools') previous.tools.push(item.tool);
      else entries.push({ kind: 'tools', id: item.tool.id, at: item.tool.at, tools: [item.tool] });
    } else if (item.message) {
      entries.push({ kind: 'message', id: item.message.id, at: item.message.at, message: item.message });
    }
  }
  return entries;
}

export function ConversationToolGroup({ tools, defaultOpen = false }: { tools: ToolActivity[]; defaultOpen?: boolean }) {
  if (!tools.length) return null;
  const label = summarizeToolGroup(tools);
  const clauses=toolGroupClauses(tools);
  const summary = <span className="conversation-tool-group-summary" title={label}>
    {clauses.map((clause,index)=><span key={clause.category} className="conversation-tool-group-clause"><Icon name={CATEGORY_ICONS[clause.category]} size={13} className="conversation-tool-group-icon"/><span className="conversation-tool-group-label">{clause.text}{index<clauses.length-1?',':''}</span></span>)}
  </span>;
  return <div className="conversation-tool-group" data-history-row data-tool-group-id={tools[0].id} data-tool-count={tools.length} aria-label="Tool activity">
    <Disclosure title={label} triggerContent={summary} compact chevronEnd defaultOpen={defaultOpen} className="conversation-tool-group-disclosure">
      <div className="conversation-tool-group-list">
        {tools.map(tool => <ConversationToolCall key={tool.id} tool={tool} />)}
      </div>
    </Disclosure>
  </div>;
}
