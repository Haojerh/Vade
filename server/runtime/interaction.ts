import crypto from 'node:crypto';
import type { AdeProvider, AgentInteraction } from '../../shared/contracts.js';

/** Read the current rendered choice UI only. Never interpret a transcript/tool result as a prompt. */
export function terminalInteraction(screen: string, provider: AdeProvider, identity: string, approvalContext?: string): AgentInteraction | null {
  if (provider === 'terminal' || /multi.?select|space to (?:select|toggle)|select all that apply/i.test(screen)) return null;
  const lines = screen.split('\n');
  const options = lines.flatMap((line, index) => {
    const match = /^\s*[›❯>●]?\s*([1-9])[.)]\s+(.{1,240})$/.exec(line);
    return match ? [{ id: match[1], label: match[2].trim(), line: index }] : [];
  });
  if (options.length < 2 || options.length > 9 || options.some((option, index) => option.id !== String(index + 1))) return null;
  const before = lines.slice(Math.max(0, options[0].line - 10), options[0].line);
  const candidates = before.filter(line => line.trim() && !/for shortcuts|Esc to|enter to|tab to/i.test(line));
  const question = (candidates.find(line => /^\s*(?:would you|do you|may I|can I|which|what|how|please (?:choose|select)|choose|select|allow|approve|permission|approval|proceed|continue)\b/i.test(line))
    ?? [...candidates].reverse().find(line => /\?/.test(line) && !/^\s*[$>]/.test(line)))?.trim();
  if (!question) return null;
  const approval = /allow|permission|approval|proceed|run.*command|make.*edit/i.test(question)
    && options.some(option => /^(yes|allow|approve)\b/i.test(option.label)) && options.some(option => /^(no|deny|reject)\b/i.test(option.label));
  const textOption = options.find(option => /^(other\b|type (?:something|your)|write[- ]in|write (?:your|an))/i.test(option.label));
  const questionIndex = candidates.findIndex(line => line.trim() === question);
  const detail = approval ? approvalContext || candidates.slice(questionIndex + 1).join('\n').trim().slice(0, 1500) : '';
  if (approval && !detail) return null;
  return { id: crypto.createHash('sha256').update(identity + ':' + screen).digest('hex'), kind: approval ? 'approval' : 'question', ...(detail ? { detail } : {}),
    question: question.slice(0, 1000), options: options.map(({ id, label }) => ({ id, label })), ...(textOption ? { textOptionId: textOption.id } : {}) };
}
