import { useEffect, useRef, useState } from 'react';
import type { AgentChatOptions, SetAgentChatOptionRequest } from '../../../shared/contracts';
import { fetchAgentChatOptions, setAgentChatOption } from '../../api/client';
import { Icon } from '../../components/ui/Icon';
import { Popover } from '../../components/ui/Popover';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { usePopoverState } from '../../hooks/usePopoverState';

interface Props {
  projectId: string;
  nodeId: string;
  runId: string | null;
  model?: string | null;
  effort?: string | null;
  disabled?: boolean;
  /** A `/model` or `/effort` composer command opens this picker and marks one section. */
  openRequest?: { id: number; section: 'model' | 'effort' } | null;
  /** Called once the request was consumed, so a remount cannot replay it. */
  onOpenRequestHandled?: () => void;
}

// Keep the last observed session settings across Chat/Terminal remounts. Reads
// still refresh them, and mutations always go through backend validation.
const recentSettings = new Map<string, { at: number; options: AgentChatOptions }>();
function rememberSettings(key: string, options: AgentChatOptions) {
  recentSettings.delete(key);
  if (recentSettings.size >= 64) recentSettings.delete(recentSettings.keys().next().value!);
  recentSettings.set(key, { at: Date.now(), options });
}

export function AgentChatControls(props: Props) {
  return <BoundAgentChatControls key={`${props.projectId}:${props.nodeId}:${props.runId ?? ''}`} {...props} />;
}

function BoundAgentChatControls({ projectId, nodeId, runId, model, effort, disabled, openRequest, onOpenRequestHandled }: Props) {
  const cacheKey = JSON.stringify([projectId, nodeId, runId]);
  const overlay = usePopoverState();
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const [options, setOptions] = useState<AgentChatOptions | null>(() => {
    const cached = recentSettings.get(cacheKey);
    return cached && Date.now() - cached.at < 300000 ? cached.options : null;
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [highlight, setHighlight] = useState<'model' | 'effort' | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handledOpenRequest = useRef(0);
  const catalogRetries = useRef(0);
  const effortRequests = useRef(new Set<string>());
  useEffect(() => () => { request.current?.abort(); mutation.current?.abort(); clearTimeout(highlightTimer.current); }, []);
  useEffect(() => {
    // The composer is remounted when returning from Terminal. Read its effective
    // settings immediately, even while the picker is closed; refresh on open too.
    if (overlay.closing) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    fetchAgentChatOptions(projectId, nodeId, runId, controller.signal).then(section => {
      if (controller.signal.aborted) return;
      setOptions(section.data);
      if (section.data && !section.meta.stale) rememberSettings(cacheKey, section.data);
      else recentSettings.delete(cacheKey);
      setError(section.meta.issue?.message ?? (section.meta.stale ? 'Settings may be out of date. Reopen to refresh.' : null));
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load agent settings.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [overlay.present, overlay.closing, projectId, nodeId, runId, cacheKey, refresh]);

  useEffect(() => {
    if (!openRequest || openRequest.id === handledOpenRequest.current) return;
    handledOpenRequest.current = openRequest.id;
    // A composer command opens the same picker the trigger does, then marks the
    // requested section so the user lands on model or effort instead of searching.
    setQuery('');
    overlay.open();
    setHighlight(openRequest.section);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlight(null), 2000);
    onOpenRequestHandled?.();
  }, [openRequest, overlay.open, onOpenRequestHandled]);
  useEffect(() => { if (!overlay.present) setHighlight(null); }, [overlay.present]);
  useEffect(() => {
    if (!overlay.present || !highlight) return;
    // Bring the requested section into view inside the picker, never the page.
    content.current?.querySelector<HTMLElement>(`[data-composer-section="${highlight}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [overlay.present, highlight, options]);

  useEffect(() => {
    if (!overlay.present || overlay.closing) { catalogRetries.current = 0; return; }
    if (loading || saving || error || options?.provider !== 'dsh' || options.models.length || catalogRetries.current >= 15) return;
    const timer = setTimeout(() => { catalogRetries.current++; setRefresh(value => value + 1); }, 1000);
    return () => clearTimeout(timer);
  }, [overlay.present, overlay.closing, loading, saving, error, options]);

  async function change(key: SetAgentChatOptionRequest['key'], value: string) {
    if (saving || (loading && !options) || disabled || overlay.closing) return;
    request.current?.abort();
    // An aborted refresh cannot clear its loading state in finally. Model
    // changes must release it so effort discovery can run in this overlay.
    setLoading(false);
    const controller = new AbortController();
    mutation.current = controller;
    setSaving(true);
    setError(null);
    try {
      const updated = await setAgentChatOption(projectId, nodeId, runId, { key, value }, controller.signal);
      if (!controller.signal.aborted) { setOptions(updated); rememberSettings(cacheKey, updated); }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to change setting. Check Terminal before retrying.');
    } finally { if (!controller.signal.aborted) setSaving(false); }
  }

  useEffect(() => {
    if (options?.provider === 'codebuddy' && options.current.model && !options.controls.providerPicker) effortRequests.current.delete(options.current.model);
    if (!overlay.present || overlay.closing || loading || saving || disabled || options?.provider !== 'codebuddy' || !options.controls.providerPicker || !options.current.model) return;
    const key = options.current.model;
    if (effortRequests.current.has(key)) return;
    effortRequests.current.add(key);
    void change('providerPicker', 'open');
  }, [overlay.present, overlay.closing, loading, saving, disabled, options]);

  const current = options?.current;
  const selected = options?.models.find(item => item.id === current?.model);
  const observedModel = current?.model ?? (model !== 'unknown' ? model : null);
  const observedEffort = current?.effort ?? (effort !== 'unknown' ? effort : null);
  const locked = (loading && !options) || saving || disabled || overlay.closing;
  const models = options?.models.filter(item => `${item.label} ${item.id} ${item.description ?? ''}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const hasFast = options?.controls.fastMode || options?.controls.fastToggle;
  return <div className="agent-settings agent-chat-controls">
    <button ref={trigger} type="button" className="agent-settings-trigger" disabled={disabled || saving}
      aria-expanded={overlay.present && !overlay.closing} aria-haspopup="dialog" onClick={overlay.toggle} title="Model and agent settings" aria-label={`Model and agent settings: ${selected?.label??observedModel??'Provider default'}${observedEffort?`, ${observedEffort}`:''}`}>
      <Icon name="sliders-horizontal" size={16} className="agent-settings-compact-icon" />
      <span className="agent-settings-model-label">{selected?.label ?? observedModel ?? (loading ? 'Loading model…' : 'Model settings')}</span>
      {observedEffort && <span className="text-muted">{observedEffort}</span>}
      <Icon name="chevron-down" size={12} />
    </button>
    <Popover isOpen={overlay.present} isClosing={overlay.closing} onClose={overlay.close} triggerRef={trigger} contentRef={content}
      floating floatingWidth={440} placement="top" portal className="agent-settings-popover" aria-label="Model and agent settings" inert={overlay.closing}>
      <label className="agent-settings-search"><Icon name="search" size={16} />
        <input aria-label="Search models" placeholder="Search models…" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      {loading && !options && <p className="agent-settings-message" role="status">Loading agent settings…</p>}
      {error && <p className="agent-settings-message text-danger" role="alert">{error}</p>}
      {(!loading || options) && <>
        <div className={`agent-settings-models${highlight === 'model' ? ' is-highlighted' : ''}`} aria-label="Models" data-composer-section="model">
          {models.map(item => <button type="button" key={item.id} className="agent-settings-model" aria-pressed={current?.model === item.id}
            disabled={locked || !options?.controls.model} onClick={() => void change('model', item.id)}>
            <span><strong>{item.label}</strong>{item.description && <span className="text-muted">{item.description}</span>}</span>
            {current?.model === item.id && <Icon name="check" size={16} />}
          </button>)}
          {!models.length && <p className="agent-settings-message">{options?.models.length ? 'No matching models.' : options?.provider === 'dsh' ? 'Waiting for the native DSH model catalog. Finish setup in Terminal; reopen this picker to retry.' : ['codebuddy','opencode','opencode2','kilo'].includes(options?.provider ?? '') ? 'Change model and effort in Terminal. Current settings appear after a recorded turn.' : 'No model catalog available.'}</p>}
        </div>
        {options?.controls.providerPicker && options.provider !== 'codebuddy' && <button type="button" className="agent-settings-native" disabled={locked} onClick={() => void change('providerPicker', 'open')}>Open model picker in Terminal</button>}
        {options?.controls.effort && !!selected?.efforts.length && <div className={`agent-chat-option-row${highlight === 'effort' ? ' is-highlighted' : ''}`} data-composer-section="effort"><span>Effort</span><SegmentedControl key={selected.id} label="Effort" choices={selected.efforts.map(item => ({ ...item, label: item.value === 'medium' ? 'Med' : item.label }))} value={current?.effort} disabled={locked} onChange={value => void change('effort', value)} /></div>}
        {options?.controls.serviceTier && !!selected?.serviceTiers?.length && <div className="agent-chat-option-row"><span>Speed</span><SegmentedControl label="Speed" choices={selected.serviceTiers} value={current?.serviceTier} disabled={locked} onChange={value => void change('serviceTier', value)} /></div>}
        {hasFast && <div className="agent-chat-option-row"><span>Speed</span>
          {options?.controls.fastMode ? <SegmentedControl label="Fast mode" choices={[{ value: 'false', label: 'Standard' }, { value: 'true', label: 'Fast' }]} value={typeof current?.fastMode === 'boolean' ? String(current.fastMode) : undefined} disabled={locked} onChange={value => void change('fastMode', value)} />
            : <button type="button" disabled={locked} onClick={() => void change('fastToggle', 'open')}>Toggle fast mode in Terminal</button>}
        </div>}
        {options?.unconfirmed && <p className="agent-settings-message" role="status">Change sent. Confirm the setting in Terminal.</p>}
        {options && !options.unconfirmed && (!current?.model || (options.controls.effort && !current.effort) || (hasFast && current.fastMode === undefined) || (options.controls.serviceTier && !current.serviceTier)) && <p className="agent-settings-message">Some current settings are unknown.</p>}
        {!options && !error && <p className="agent-settings-message">Settings unavailable for this session.</p>}
        {saving && <p className="agent-settings-message" role="status">Applying setting…</p>}
      </>}
    </Popover>
  </div>;
}
