import crypto from 'node:crypto';
import type { AdeProvider, AgentInteraction } from '../../shared/contracts.js';
import type { ChatControlIO } from './chatControlTypes.js';
import { CliError } from '../integrations/cli.js';

/** CodeBuddy hooks also run for permission checks that never open a widget. */
export function codeBuddyApprovalVisible(screen: string): boolean {
  const widget = screen.split('\n').map(line => line.replace(/^[\s\u2502\u2503|]+/, '').replace(/[\u2502\u2503|]\s*$/, '')).join('\n');
  const heading = /(?:Do you want to (?:proceed|allow|run|make)|Are you sure you want to do this|Allow (?:this|the) ).{0,500}?\?/i;
  return (heading.test(widget.replace(/\s+/g, ' ')) || heading.test(widget.replace(/\n/g, '').replace(/\s+/g, ' ')))
    && /^\s*[\u203a\u276f>\u25cf]\s*[1-9][.)]\s+/m.test(widget)
    && /^\s*[\u203a\u276f>\u25cf]?\s*1[.)]\s+(?:Yes|Allow)\b/im.test(widget)
    && /^\s*[\u203a\u276f>\u25cf]?\s*[2-9][.)]\s+(?:No|Deny|Reject)\b/im.test(widget);
}

/** Read the current rendered choice UI only. Never interpret a transcript/tool result as a prompt. */
export function terminalInteraction(screen: string, provider: AdeProvider, identity: string, approvalContext?: string): AgentInteraction | null {
  if (provider === 'terminal' || /multi.?select|space to (?:select|toggle)|select all that apply/i.test(screen)) return null;
  // OpenCode/Kilo draw prompts inside bordered panels; strip the frame so numbered rows and the question remain parseable.
  const framed = provider === 'opencode' || provider === 'opencode2' || provider === 'kilo';
  const lines = screen.split('\n').map(line => framed ? line.replace(/^[\s│┃┆▌▏|]+/, '  ').replace(/[\s│┃┆▐▕|]+$/, '') : line);
  const options = lines.flatMap((line, index) => {
    const match = /^\s*[›❯>●]?\s*([1-9])[.)]\s+(.{1,240})$/.exec(line);
    return match ? [{ id: match[1], label: match[2].trim(), line: index }] : [];
  });
  if (options.length < 2 || options.length > 9 || options.some((option, index) => option.id !== String(index + 1))) return null;
  const before = lines.slice(Math.max(0, options[0].line - 10), options[0].line);
  const candidates = before.filter(line => line.trim() && !/for shortcuts|Esc to|enter to|tab to/i.test(line));
  const question = (candidates.find(line => /^\s*(?:would you|do you|may I|can I|which|what|how|please (?:choose|select)|choose|select|allow|approve|permission|approval|proceed|continue)\b/i.test(line))
    ?? [...candidates].reverse().find(line => /\?/.test(line) && !/^\s*[$>]/.test(line)))?.trim() ?? (framed ? [...candidates].reverse().find(line => !/^\s*(?:[↑↓⇆]|esc\b)/i.test(line))?.trim() : undefined);
  if (!question) return null;
  const approval = /allow|permission|approval|proceed|run.*command|make.*edit/i.test(question)
    && options.some(option => /^(yes|allow|approve)\b/i.test(option.label)) && options.some(option => /^(no|deny|reject)\b/i.test(option.label));
  const textOption = options.find(option => /^(other\b|type (?:something|your)|write[- ]in|write (?:your|an))/i.test(option.label));
  const questionIndex = candidates.findIndex(line => line.trim() === question);
  const detail = approval ? approvalContext || candidates.slice(questionIndex + 1).join('\n').trim().slice(0, 1500) : '';
  if (approval && !detail) return null;
  const content = provider === 'codebuddy' && !approval ? JSON.stringify([question, detail, options.map(({ id, label }) => [id, label]), textOption?.id]) : screen;
  return { id: crypto.createHash('sha256').update(identity + ':' + content).digest('hex'), kind: approval ? 'approval' : 'question', ...(detail ? { detail } : {}),
    question: question.slice(0, 1000), options: options.map(({ id, label }) => ({ id, label })), ...(textOption ? { textOptionId: textOption.id } : {}) };
}

/** CodeBuddy's numbered labels are display-only; its native widget uses arrows,
 * Enter, and a separate review page. Every transition is observed before input. */
export async function answerCodeBuddyQuestion(prompt: AgentInteraction, optionId: string, text: string | undefined, io: ChatControlIO): Promise<void> {
  const fail = () => new CliError('RUNTIME_UNAVAILABLE', 'The native question changed. Inspect Terminal before retrying; no answer was replayed.');
  const selected = (screen: string) => /^\s*[›❯>●]\s*([1-9])[.)]/m.exec(screen)?.[1];
  const same = (screen: string) => {
    const current = terminalInteraction(screen, 'codebuddy', 'current');
    return current?.question === prompt.question && JSON.stringify(current.options) === JSON.stringify(prompt.options);
  };
  const screen = io.screen(), from = selected(screen);
  if (!from || !same(screen) || !/Enter to select/.test(screen) || !/Esc to cancel/.test(screen)) throw fail();
  const delta = Number(optionId) - Number(from);
  if (delta) {
    await io.write((delta > 0 ? '\x1b[B' : '\x1b[A').repeat(Math.abs(delta)));
    await io.waitFor(value => same(value) && selected(value) === optionId);
  }
  if (text) await io.write(`\x1b[200~${text.trim()}\x1b[201~`);
  await io.write('\r');
  const next = await io.waitFor(value => {
    if (/Review your answers/.test(value)) return /^\s*[›❯>●]\s*1[.)]\s+Submit answers\s*$/m.test(value) && /^\s*2[.)]\s+Cancel\s*$/m.test(value);
    const current = terminalInteraction(value, 'codebuddy', 'current');
    return Boolean(current && current.question !== prompt.question && /Enter to select/.test(value));
  });
  if (!/Review your answers/.test(next)) return; // The next question needs its own user answer.
  const expected = text?.trim() ?? prompt.options.find(option => option.id === optionId)?.label;
  const compact = (value: string) => value.replace(/\s/g, '');
  if (!expected || /You have not answered all questions/.test(next) || !compact(next).includes(compact(prompt.question)) || !compact(next).includes(compact(expected))
    || !/^\s*[›❯>●]\s*1[.)]\s+Submit answers\s*$/m.test(next) || !/^\s*2[.)]\s+Cancel\s*$/m.test(next)) throw fail();
  await io.write('\r');
}
