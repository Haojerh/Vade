import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import type { TerminalClientMessage, TerminalServerMessage } from '../../../shared/contracts';
import { markTabClosed, resumeTerminal } from '../../api/client';
import { isTerminalReply, isTerminalClipboardShortcut } from './terminalInput';
import { Icon } from '../../components/ui/Icon';
import { attachTerminalTouch } from './terminalTouch';
import { whenTerminalSurfaceReady } from './terminalSurface';

export function AgentTerminal({ projectId, nodeId, provider, onStatusChange, streamPath, setupLabel = 'Installation' }: { projectId: string; nodeId: string; provider?: string; onStatusChange?: () => void; streamPath?: string; setupLabel?: string }) {
  const statusChange = useRef(onStatusChange); statusChange.current = onStatusChange;
  const host = useRef<HTMLDivElement>(null);
  const [surfaceReady, setSurfaceReady] = useState(false);
  useEffect(() => host.current ? whenTerminalSurfaceReady(host.current, () => setSurfaceReady(true)) : undefined, []);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [retry, setRetry] = useState(0);
  const [resumable, setResumable] = useState(false);
  const [restartable, setRestartable] = useState(false);
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
    if (!host.current || !surfaceReady) return;
    const rootStyle = getComputedStyle(document.documentElement);
    const terminal = new Terminal({ cursorBlink: true, scrollback: 3000, fontSize: 13,
      fontFamily: 'Consolas, monospace', allowProposedApi: false,
      theme: { background: rootStyle.getPropertyValue('--terminal-bg').trim(), foreground: rootStyle.getPropertyValue('--terminal-fg').trim(), cursor: '#ededed', cursorAccent: '#181818', selectionBackground: '#ffffff33' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current);
    const disposeTouch = attachTerminalTouch(host.current, terminal);
    // Fullscreen Codex owns its transcript scrollback. Preserve its observed
    // mouse modes so wheel/touch input can scroll that native UI. Normal-buffer
    // history remains local; Shift-drag retains native xterm text selection.
    if (provider === 'codex') terminal.attachCustomWheelEventHandler(event => {
      if (terminal.buffer.active.type === 'alternate' && terminal.modes.mouseTrackingMode !== 'none') return true;
      event.preventDefault();
      terminal.scrollLines(Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / (event.deltaMode === 0 ? 24 : 1))));
      return false;
    });
    if (provider === 'opencode' || provider === 'opencode2' || provider === 'kilo') {
      const replays = new WeakSet<WheelEvent>();
      terminal.attachCustomWheelEventHandler(event => {
        if (replays.has(event) || terminal.modes.mouseTrackingMode === 'none' || event.shiftKey || !event.deltaY) return true;
        event.preventDefault();
        const target = event.target instanceof Element ? event.target : terminal.element;
        const rows = Math.min(8, Math.max(1, Math.round(Math.abs(event.deltaY) / (event.deltaMode === 0 ? 24 : 1))));
        // Line-mode reports bypass xterm's pixel-wheel damping in fullscreen TUIs.
        // Keep native mouse coordinates/encoding; never translate a wheel into Up/Down.
        queueMicrotask(() => {
          if (!terminal.element?.isConnected) return;
          for (let row = 0; row < rows; row++) {
            const replay = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: event.clientX, clientY: event.clientY, deltaY: Math.sign(event.deltaY), deltaMode: 1 });
            replays.add(replay); target?.dispatchEvent(replay);
          }
        });
        return false;
      });
    }
    // Let Chromium deliver native clipboard events before xterm's Kitty encoder claims them.
    terminal.attachCustomKeyEventHandler(event => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v' && navigator.clipboard?.readText) {
        if (event.type === 'keydown') {
          event.preventDefault(); event.stopPropagation();
          if (!event.repeat) void navigator.clipboard.readText().then(text => { if (active) terminal.paste(text); }).catch(() => { if (active) setError('Clipboard access unavailable. Use the browser paste menu or Shift+Insert.'); });
        }
        return false;
      }
      return !isTerminalClipboardShortcut(event, terminal.hasSelection());
    });
    // DOM text avoids touch-browser WebGL atlas/compositing corruption.
    if (!window.matchMedia('(any-pointer: coarse)').matches) try {
      const webgl = new WebglAddon(); webgl.onContextLoss(() => webgl.dispose()); terminal.loadAddon(webgl);
    } catch { /* xterm's default renderer remains available when WebGL is unavailable. */ }
    let cursor = 0, active = true, failed = false, initialPage = true, lastLive: boolean | undefined;
    let socket: WebSocket | null = null, frame = 0, inputTimer: ReturnType<typeof setTimeout> | undefined;
    let queuedInput = '', sentSize = '';
    const closedTab = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; nodeId: string }>).detail;
      if (detail?.projectId !== projectId || detail.nodeId !== nodeId) return;
      failed = true; queuedInput = ''; clearTimeout(inputTimer);
      const previous = socket; socket = null; previous?.close();
      setError(null); setLive(false); setResumable(false); setRestartable(false);
    };
    window.addEventListener('ade:session-closed', closedTab);
    const fail = (error: unknown) => { if (active) { failed = true; queuedInput = ''; setError((error as Error).message); } };
    const send = (message: TerminalClientMessage) => {
      if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1024 * 1024) throw new Error('Terminal disconnected. Inspect before repeating input.');
      socket.send(JSON.stringify(message));
    };
    setError(null); setLive(null);
    const fitTerminal = (claim = false) => {
      if (!active || document.hidden || !host.current?.clientWidth || !host.current?.clientHeight) return;
      terminal.resize(terminal.cols, terminal.rows); // Re-measure if first opened while hidden.
      const dimensions = fit.proposeDimensions();
      if (!dimensions) return;
      const cols = Math.min(400, dimensions.cols), rows = Math.min(200, dimensions.rows), size = `${cols}:${rows}`;
      if (cols < 20 || rows < 5 || (size === sentSize && (!claim || (terminal.cols === cols && terminal.rows === rows))) || socket?.readyState !== WebSocket.OPEN) return;
      try { send({ type: 'resize', cols, rows }); sentSize = size; } catch (error) { fail(error); }
    };
    const input = terminal.onData(data => {
      if (failed || !active || isTerminalReply(data)) return;
      fitTerminal(true);
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
      const current = new WebSocket(`${protocol}//${location.host}${streamPath ?? `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/terminal-stream`}?cursor=${cursor}`);
      socket = current; sentSize = '';
      current.onopen = () => { /* Restore the host-sized screen before asking the PTY to resize. */ };
      current.onmessage = async event => {
        if (!active || failed || socket !== current) return;
        try {
          const message = JSON.parse(event.data) as TerminalServerMessage;
          if (message.type === 'error') throw new Error(message.message);
          if (message.type !== 'output') throw new Error('Invalid terminal stream');
          const page = message.page;
          if (page.reset) terminal.reset();
          if (page.cols && page.rows && (terminal.cols !== page.cols || terminal.rows !== page.rows)) terminal.resize(page.cols, page.rows);
          if (page.data) await new Promise<void>(resolve => terminal.write(page.data, resolve));
          if (!active || socket !== current) return;
          fitTerminal(); terminal.refresh(0, terminal.rows - 1);
          cursor = page.cursor; setLive(page.live); setResumable(!streamPath && Boolean(page.resumable)); setRestartable(!streamPath && Boolean(page.restartable));
          if (lastLive !== page.live) { lastLive = page.live; statusChange.current?.(); }
          const autoResume = !streamPath && initialPage && !page.live && page.recoverable;
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
      current.onclose = event => {
        if (!active || socket !== current) return;
        if (event.code === 1000 && event.reason === 'Tab closed') {
          if (!streamPath) markTabClosed(projectId, nodeId);
          else { failed = true; queuedInput = ''; setError(null); setLive(false); }
          return;
        }
        fail(new Error('Terminal connection closed. Inspect before repeating input.'));
      };
      current.onerror = () => { if (active && socket === current) fail(new Error('Terminal connection unavailable. Reconnect to try again.')); };
    };
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fitTerminal()); }); observer.observe(host.current);
    const claimViewport = () => fitTerminal(true);
    window.addEventListener('focus', claimViewport);
    document.addEventListener('visibilitychange', claimViewport);
    host.current.addEventListener('pointerdown', claimViewport, { capture: true });
    host.current.addEventListener('wheel', claimViewport, { passive: true, capture: true });
    const surface = host.current;
    fitTerminal();
    if (!window.matchMedia('(pointer: coarse)').matches) terminal.focus();
    connect();
    return () => { active = false; window.removeEventListener('ade:session-closed', closedTab); window.removeEventListener('focus', claimViewport); document.removeEventListener('visibilitychange', claimViewport); surface.removeEventListener('pointerdown', claimViewport, true); surface.removeEventListener('wheel', claimViewport, true); clearTimeout(inputTimer); cancelAnimationFrame(frame); socket?.close(); observer.disconnect(); input.dispose(); disposeTouch(); terminal.dispose(); };
  }, [projectId, nodeId, retry, streamPath, provider, surfaceReady]);
  return <section className="agent-terminal" aria-label="Agent terminal">
    {error && <div className="panel-alert alert-error" role="alert">{error} <button className="btn btn-secondary btn-xs" onClick={() => setRetry(value => value + 1)}>Reconnect</button><span> Inspect the terminal before repeating input.</span></div>}
    <div className="agent-terminal-screen"><div ref={host} className="agent-terminal-viewport" /></div>
    <div className="agent-terminal-footer"><p className="text-xs text-muted" role="status">{streamPath ? live === false ? `${setupLabel} terminal stopped. Reopen setup to start a new one.` : `${setupLabel} terminal · press Enter to run the staged command.` : resuming ? restartable ? 'Opening a fresh shell…' : 'Resuming the same conversation…' : live === false ? restartable ? 'Shell stopped. Reopen in the same folder. Previous commands will not be replayed.' : resumable ? 'Session stopped. Resume to continue the same conversation.' : 'Session stopped. This session has no recovery binding; close its tab and start a new agent.' : 'Native terminal · authentication and permission prompts appear here.'}</p>
    {live === false && (resumable || restartable) && !resuming && <button type="button" className="btn btn-secondary" onClick={() => void resume()}><Icon name={restartable ? 'terminal' : 'play'} size={14} />{restartable ? 'Reopen terminal' : 'Resume session'}</button>}</div>
  </section>;
}
