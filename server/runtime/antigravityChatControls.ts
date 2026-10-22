import type { AgentChatOptions, SetAgentChatOptionRequest } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';
import { WorkflowModels } from './workflowModels.js';
import type { ChatControlIO } from './chatControlTypes.js';

const controls = { model: true, effort: false, fastMode: false, fastToggle: false, serviceTier: false, providerPicker: false };
const clean = (value: string) => value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '');

export class AntigravityChatControls {
  constructor(private readonly catalog: Pick<WorkflowModels, 'list'> = new WorkflowModels()) {}
  async read(observed: { model?: string | null; effort?: string | null }, screenSource: string | (() => string)): Promise<AgentChatOptions> {
    const rows = await this.catalog.list('antigravity');
    const screen = typeof screenSource === 'function' ? screenSource() : screenSource;
    const models = rows.map(row => ({ id: row.id, label: row.label, efforts: row.efforts.map(value => ({ value, label: value === 'medium' ? 'Med' : value === 'xhigh' ? 'XHigh' : value[0].toUpperCase() + value.slice(1) })) }));
    // The native footer, read only from this owned screen, changes immediately on /model and /effort.
    const footer = screen.split('\n').reverse().find(line => /(?:accept-edits|auto|plan)\s*·/.test(line));
    const found = footer && /(?:accept-edits|auto|plan)\s*·\s*(.*?)\s*·\s*(low|medium|high|xhigh|max)\s*$/.exec(footer.trim());
    const variant = found ? rows.find(row => row.label.replace(/\s*\((?:Low|Medium|High|XHigh|Max)\)$/, '') === found[1] && row.id.endsWith(`-${found[2]}`)) : undefined;
    const model = variant?.id ?? observed.model ?? undefined;
    const selected = rows.find(row => row.id === model);
    const effort = variant ? found![2] : observed.effort ?? undefined;
    return { provider: 'antigravity', transport: 'terminal', models, current: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }, controls: { ...controls, effort: Boolean(selected?.efforts.length) } };
  }

  async apply(options: AgentChatOptions, request: SetAgentChatOptionRequest, io: ChatControlIO): Promise<AgentChatOptions> {
    const rows = await this.catalog.list('antigravity');
    let target = rows.find(row => row.id === request.value);
    if (request.key === 'effort') {
      const model = rows.find(row => row.id === options.current.model);
      const id = model?.effortModels?.[request.value];
      target = rows.find(row => row.id === id);
      if (!model?.efforts.includes(request.value) || !target) throw new CliError('INVALID_ARGUMENT', 'Select an effort offered by this model');
    } else if (request.key !== 'model' || !target) throw new CliError('INVALID_ARGUMENT', 'Select a model offered by Antigravity');
    const command = request.key === 'effort' ? `/effort ${request.value}` : `/model ${target.id}`;
    // Observed in Antigravity CLI 1.4.5: both commands accept direct catalog values.
    // Never use an unrecognized slash command as a model prompt.
    await io.write(command);
    await io.write('\r');
    const confirmation = request.key === 'effort' ? `Effort set to ${request.value}` : `Model set to ${target.label}`;
    await io.waitFor(() => {
      const fresh = clean(io.output());
      const index = fresh.lastIndexOf(confirmation);
      return index >= 0 && index === fresh.lastIndexOf(request.key === 'effort' ? 'Effort set to ' : 'Model set to ');
    });
    const effort = target.id.match(/-(low|medium|high|xhigh|max)$/)?.[1];
    return { ...options, current: { model: target.id, ...(effort ? { effort } : {}) }, controls: { ...options.controls, effort: Boolean(target.efforts.length) } };
  }
}
