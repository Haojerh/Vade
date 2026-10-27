import { useEffect, useRef, useState } from 'react';
import type { AgentContextUsage } from '../../../shared/contracts';
import { Popover } from '../../components/ui/Popover';
import { useConfirmationState } from '../../hooks/useConfirmationState';
import { fetchAgentChatOptions } from '../../api/client';

export function contextPercentage(usage?: AgentContextUsage): number | null {
  return usage?.usedTokens != null && usage.windowTokens != null && usage.windowTokens > 0
    ? usage.usedTokens / usage.windowTokens * 100 : null;
}
export function formatContextTokens(count: number | null | undefined): string {
  if (count == null) return 'Unknown';
  return count >= 1e6 ? `${Number((count / 1e6).toFixed(1))}m` : count >= 1e3 ? `${Number((count / 1e3).toFixed(1))}k` : String(count);
}

export function ContextUsageMeter({ usage: observed, projectId, nodeId, runId, provider }: { usage?: AgentContextUsage; projectId: string; nodeId: string; runId: string | null; provider: string | null }) {
  const trigger = useRef<HTMLButtonElement>(null), content = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const card = useConfirmationState();
  const [catalogWindow, setCatalogWindow] = useState<{ model: string; tokens: number } | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  useEffect(() => {
    if (observed?.usedTokens == null) { clearTimeout(timer.current); card.reset(); }
  }, [observed?.usedTokens == null, card.reset]);
  useEffect(() => {
    if (observed?.windowTokens != null || observed?.usedTokens == null || !observed.model || !['opencode','opencode2','kilo','codebuddy'].includes(provider ?? '') || catalogWindow?.model === observed.model) return;
    const abort = new AbortController(); setCatalogLoading(true);
    void fetchAgentChatOptions(projectId, nodeId, runId, abort.signal).then(section => {
      if (abort.signal.aborted || section.meta.stale || !section.data) return;
      const model = section.data.models.find(model => model.id === observed.model);
      if (model?.contextWindow) setCatalogWindow({ model: model.id, tokens: model.contextWindow });
    }).catch(() => {}).finally(() => { if (!abort.signal.aborted) setCatalogLoading(false); });
    return () => { abort.abort(); setCatalogLoading(false); };
  }, [observed?.model, observed?.windowTokens, observed?.usedTokens == null, projectId, nodeId, runId, provider, catalogWindow?.model]);
  const usage = observed && observed.windowTokens == null && catalogWindow && catalogWindow.model === observed.model ? { ...observed, windowTokens: catalogWindow.tokens, reason: undefined } : observed;
  const clear = () => clearTimeout(timer.current);
  const hover = (open: boolean) => { clear(); timer.current = setTimeout(() => {
    if (open) card.open();
    else if (!trigger.current?.matches(':hover') && !content.current?.matches(':hover') && !content.current?.contains(document.activeElement)) card.close();
  }, open ? 150 : 200); };
  useEffect(() => clear, []);
  const percent = contextPercentage(usage), used = formatContextTokens(usage?.usedTokens), total = formatContextTokens(usage?.windowTokens);
  const label = percent === null ? usage?.usedTokens != null ? `Context: ${used} tokens, capacity unknown` : 'Context usage unavailable' : `Context: ${used} of ${total} tokens, ${Math.round(percent)}% used`;
  const filled = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const rows = [
    [usage?.cacheAccounting === 'included-in-input' ? 'Input (includes cache)' : usage?.cacheAccounting === 'separate' ? 'Uncached input' : 'Input', usage?.inputTokens], ['Cache read', usage?.cacheReadTokens], ['Cache write', usage?.cacheWriteTokens], ['Output', usage?.outputTokens],
  ] as const;
  if (usage?.usedTokens == null) return null;
  return <div className="context-usage-control">
    <button ref={trigger} type="button" className={`context-usage-trigger${percent !== null && percent >= 90 ? ' is-critical' : ''}${percent === null ? ' is-unknown' : ''}`} aria-label={label} aria-expanded={card.present && !card.closing} aria-haspopup="dialog"
      onPointerEnter={event => { if (event.pointerType === 'mouse') hover(true); }} onPointerLeave={event => { if (event.pointerType === 'mouse') { if (event.relatedTarget instanceof globalThis.Node && content.current?.contains(event.relatedTarget)) clear(); else hover(false); } }}
      onClick={() => { clear(); if (card.present && !card.closing) card.close(); else card.open(); }} onKeyDown={event => { if (event.key === 'Escape') { clear(); card.close(); } }}>
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle className="context-ring-track" cx="10" cy="10" r="7"/><circle className="context-ring-fill" cx="10" cy="10" r="7" pathLength="100" strokeDasharray={`${filled} 100`} transform="rotate(-90 10 10)"/>{percent === null && <text x="10" y="13" textAnchor="middle">?</text>}</svg>
    </button>
    <Popover isOpen={card.present} isClosing={card.closing} triggerRef={trigger} contentRef={content} onClose={() => { clear(); card.close(); }} floating floatingWidth={320} placement="top" className="context-usage-popover" aria-label="Context usage details"
      onPointerEnter={clear} onPointerLeave={event => { if (event.pointerType === 'mouse') { if (event.relatedTarget instanceof globalThis.Node && trigger.current?.contains(event.relatedTarget)) clear(); else hover(false); } }}>
      <div className="context-usage-heading"><strong>Context</strong><span title={usage?.usedTokens != null ? `${usage.usedTokens.toLocaleString()} / ${usage.windowTokens?.toLocaleString() ?? 'unknown capacity'} tokens` : undefined}>{used}{usage?.windowTokens != null ? ` / ${total}` : ''}</span></div>
      {percent !== null && <><div className="context-usage-progress" role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(filled)} aria-valuetext={`${Math.round(percent)}% used`}><span style={{ width: `${filled}%` }} /></div><p className="context-usage-remaining">{Math.round(percent)}% used · {Math.max(0, usage!.windowTokens! - usage!.usedTokens!).toLocaleString()} tokens remaining</p></>}
      {rows.some(([, value]) => value != null) && <dl className="context-usage-breakdown">{rows.filter(([, value]) => value != null).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value!.toLocaleString()}</dd></div>)}</dl>}
      <p className="context-usage-note">{usage?.reason ?? (usage?.usedTokens == null ? 'No native context reading is available yet.' : usage.windowTokens == null ? 'The provider reports token usage but has not reported this model’s context capacity.' : usage.estimated ? 'Provider estimate from the latest native context record.' : usage.measurement === 'last-request' ? 'Measured from the last native request. Context may change before the next request.' : 'Latest context measurement reported by the provider.')}</p>
      {catalogLoading && <p className="context-usage-note" role="status">Reading native model capacity…</p>}
      {usage?.usedTokens != null && usage.measurement === 'last-request' && <p className="context-usage-note">Input and cache rows follow provider accounting; output is shown separately. These are request counts, not session totals.</p>}
      {usage?.model && <p className="context-usage-note context-usage-model">Measured model: {usage.model}</p>}
      {usage?.observedAt && <footer className="context-usage-source">{usage.source} · <time dateTime={usage.observedAt}>{new Date(usage.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></footer>}
    </Popover>
  </div>;
}
