import React, { useEffect, useRef, useState } from 'react';
import type { AgentInteraction as Prompt } from '../../../../shared/contracts';
import { answerAgentInteraction, fetchAgentInteraction } from '../../../api/client';

export function AgentInteraction({ projectId, nodeId, waiting, onTerminal }: { projectId: string; nodeId: string; waiting: boolean; onTerminal: () => void }) {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [attempted, setAttempted] = useState('');
  const request = useRef<AbortController | null>(null);
  const promptId = useRef<string | null>(null);
  useEffect(() => {
    if (!prompt || prompt.id === promptId.current) return;
    promptId.current = prompt.id; setError(''); setText(''); setAttempted('');
  }, [prompt]);
  useEffect(() => {
    const abort = new AbortController(); let busy = false;
    const read = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try { const next = await fetchAgentInteraction(projectId, nodeId, abort.signal); if (!abort.signal.aborted) { setPrompt(next.data); setReadError(''); } }
      catch (e) { if (!abort.signal.aborted) setReadError((e as Error).message); }
      finally { busy = false; }
    };
    void read(); const timer = setInterval(() => { void read(); }, 1000);
    return () => { abort.abort(); request.current?.abort(); clearInterval(timer); };
  }, [projectId, nodeId]);
  const answer = async (optionId: string) => {
    if (!prompt || sending || attempted === prompt.id) return;
    const abort = new AbortController(); request.current = abort;
    setSending(true); setAttempted(prompt.id); setError('');
    try { await answerAgentInteraction(projectId, nodeId, { promptId: prompt.id, optionId, ...(optionId === prompt.textOptionId ? { text } : {}) }, abort.signal); if (!abort.signal.aborted) { setPrompt(null); setText(''); } }
    catch (e) { if (!abort.signal.aborted) setError(`${(e as Error).message} Inspect Terminal before retrying.`); }
    finally { if (!abort.signal.aborted) setSending(false); }
  };
  const issue = error || readError;
  if (!prompt && !waiting && !issue) return null;
  return <section className="agent-interaction" aria-label="Agent needs input" aria-live="polite">
    <strong>{prompt ? prompt.kind === 'approval' ? 'Approval required' : 'Agent question' : 'Agent needs input'}</strong>
    {prompt ? <><p>{prompt.question}</p>{prompt.detail && <pre className="agent-interaction-detail">{prompt.detail}</pre>}<div className="agent-interaction-options">{prompt.options.filter(option => option.id !== prompt.textOptionId).map(option => <button key={option.id} type="button" className="btn btn-secondary" disabled={sending || attempted === prompt.id} onClick={() => { void answer(option.id); }}>{option.label}</button>)}</div>
      {prompt.textOptionId && <form onSubmit={event => { event.preventDefault(); void answer(prompt.textOptionId!); }}><label>Other answer<input value={text} maxLength={2000} disabled={sending || attempted === prompt.id} onChange={event => setText(event.target.value)} /></label><button className="btn btn-secondary" disabled={!text.trim() || sending || attempted === prompt.id}>Submit answer</button></form>}</>
      : <p>{sending || attempted ? 'Waiting for the provider to continue.' : 'This prompt needs its native terminal controls.'}</p>}
    {issue && <p role="alert" className="text-danger">{issue}</p>}
    <button type="button" className="btn btn-secondary btn-sm" onClick={onTerminal}>Open Terminal</button>
  </section>;
}
