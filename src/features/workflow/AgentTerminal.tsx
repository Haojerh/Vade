import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { TerminalClientMessage, TerminalServerMessage } from '../../../shared/contracts';
import { resumeTerminal } from '../../api/client';

export function AgentTerminal({ projectId, nodeId, onStatusChange }: { projectId: string; nodeId: string; onStatusChange?: () => void }) {
  const statusChange = useRef(onStatusChange); statusChange.current = onStatusChange;
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [retry, setRetry] = useState(0);
  const [resumable, setResumable] = useState(false);
  const [resuming, setResuming] = useState(false);
  const active = useRef(true);
  const selection = useRef(''); selection.current = `${projectId}/${nodeId}`;
  useEffect(() => { active.current = true; setResuming(false); return () => { active.current = false; }; }, [projectId, nodeId]);
  const resume = async () => {
    if (resuming) return;
    const target = selection.current;
    const current = () => active.current && selection.current === target;
    setResuming(true); setError(null);
    try { await resumeTerminal(projectId, nodeId); if (current()) setRetry(value => value + 1); }
    catch (error) { if (current()) setError((error as Error).message); }
    finally { if (current()) setResuming(false); }
  };
  useEffect(() => {
    if (!host.current) return;
    const rootStyle = getComputedStyle(document.documentElement);
    const terminal = new Terminal({ cursorBlink: true, scrollback: 3000, fontSize: 13,
      fontFamily: 'Consolas, monospace', allowProposedApi: false,
      theme: { background: rootStyle.getPropertyValue('--canvas-bg').trim(), foreground: rootStyle.getPropertyValue('--text-main').trim() } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current);
    try {
      const webgl = new WebglAddon(); webgl.onContextLoss(() => webgl.dispose()); terminal.loadAddon(webgl);
    } catch { /* xterm's default renderer remains available when WebGL is unavailable. */ }
    let cursor = 0, active = true, failed = false, initialPage = true, lastLive: boolean | undefined;
    let socket: WebSocket | null = null, frame = 0, inputTimer: ReturnType<typeof setTimeout> | undefined;
    let queuedInput = '', sentSize = '';
    const fail = (error: unknown) => { if (active) { failed = true; queuedInput = ''; setError((error as Error).message); } };
    const send = (message: TerminalClientMessage) => {
      if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1024 * 1024) throw new Error('Terminal disconnected. Inspect before repeating input.');
      socket.send(JSON.stringify(message));
    };
    setError(null); setLive(null);
    const fitTerminal = () => {
      if (!active || !host.current?.clientWidth) return;
      fit.fit();
      const cols = Math.min(400, terminal.cols), rows = Math.min(200, terminal.rows), size = `${cols}:${rows}`;
      if (cols < 20 || rows < 5 || size === sentSize || socket?.readyState !== WebSocket.OPEN) return;
      try { send({ type: 'resize', cols, rows }); sentSize = size; } catch (error) { fail(error); }
    };
    const input = terminal.onData(data => {
      if (failed || !active) return;
      queuedInput += data;
      if (queuedInput.length > 262144) { fail(new Error('Terminal input is too large. Paste smaller sections.')); return; }
      if (inputTimer) return;
      inputTimer = setTimeout(() => {
        inputTimer = undefined;
        try {
          // One ordered socket replaces one HTTP round trip per keystroke. Never replay input.
          while (queuedInput) { const data = queuedInput.slice(0, 16384); queuedInput = queuedInput.slice(data.length); send({ type: 'input', data }); }
        } catch (error) { fail(error); }
      }, 4);
    });
    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const current = new WebSocket(`${protocol}//${location.host}/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/terminal-stream?cursor=${cursor}`);
      socket = current; sentSize = '';
      current.onopen = fitTerminal;
      current.onmessage = async event => {
        if (!active || failed || socket !== current) return;
        try {
          const message = JSON.parse(event.data) as TerminalServerMessage;
          if (message.type === 'error') throw new Error(message.message);
          if (message.type !== 'output') throw new Error('Invalid terminal stream');
          const page = message.page;
          if (page.reset) terminal.reset();
          if (page.data) await new Promise<void>(resolve => terminal.write(page.data, resolve));
          if (!active || socket !== current) return;
          cursor = page.cursor; setLive(page.live); setResumable(Boolean(page.resumable));
          if (lastLive !== page.live) { lastLive = page.live; statusChange.current?.(); }
          const autoResume = initialPage && !page.live && page.resumable;
          initialPage = false;
          if (autoResume) {
            setResuming(true); socket = null; current.close();
            try {
              await resumeTerminal(projectId, nodeId);
              if (active) { cursor = 0; terminal.reset(); connect(); }
            } finally { if (active) setResuming(false); }
          } else send({ type: 'ack', cursor });
        } catch (error) { fail(error); }
      };
      current.onclose = () => { if (active && socket === current) fail(new Error('Terminal connection closed. Inspect before repeating input.')); };
      current.onerror = () => { if (active && socket === current) fail(new Error('Terminal connection unavailable. Reconnect to try again.')); };
    };
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fitTerminal); }); observer.observe(host.current);
    fitTerminal(); terminal.focus(); connect();
    return () => { active = false; clearTimeout(inputTimer); cancelAnimationFrame(frame); socket?.close(); observer.disconnect(); input.dispose(); terminal.dispose(); };
  }, [projectId, nodeId, retry]);
  return <section className="agent-terminal" aria-label="Agent terminal">
    {error && <div className="panel-alert alert-error" role="alert">{error} <button className="btn btn-secondary btn-xs" onClick={() => setRetry(value => value + 1)}>Reconnect</button><span> Inspect the terminal before repeating input.</span></div>}
    <div ref={host} className="agent-terminal-screen" />
    <p className="text-xs text-muted" role="status">{resuming ? 'Resuming the same conversation…' : live === false ? resumable ? 'Session stopped. Resume to continue the same conversation.' : 'Session stopped. This session has no recovery binding; close its tab and start a new agent.' : 'Native agent terminal · authentication and permission prompts appear here.'}</p>
    {live === false && resumable && !resuming && <button type="button" className="btn btn-secondary" onClick={() => void resume()}>Resume session</button>}
  </section>;
}
