import React, { useEffect, useRef, useState } from 'react';
import type { AppResources, ComputerAwakeStatus, ResourceDetails, WorkspacePort, WorkspacePorts } from '../../shared/contracts';
import { systemRequest } from '../api/client';
import { Icon } from '../components/ui/Icon';
import { Popover } from '../components/ui/Popover';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Disclosure } from '../components/ui/Disclosure';
import { DialogActions, DialogError } from '../components/ui/DialogActions';
import { usePopoverState } from '../hooks/usePopoverState';
import { useConfirmationState } from '../hooks/useConfirmationState';

const modes = [{ id: 'on', label: 'On', text: 'Keep this computer awake continuously.' }, { id: 'agent', label: 'Agent', text: 'Stay awake while an agent is working.' }, { id: 'off', label: 'Off', text: 'Allow normal system sleep behavior.' }] as const;
function useComputerAwake() {
  const [status, setStatus] = useState<ComputerAwakeStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    const abort = new AbortController(); mounted.current = true;
    const read = () => { if (!document.hidden) void systemRequest<ComputerAwakeStatus>('computer-awake', undefined, abort.signal).then(value => { if (!abort.signal.aborted) { setStatus(value); setError(''); } }).catch(error => { if (!abort.signal.aborted) setError(error.message); }); };
    read(); const timer = setInterval(read, 3000); window.addEventListener('vade:awake-change', read);
    return () => { mounted.current = false; abort.abort(); clearInterval(timer); window.removeEventListener('vade:awake-change', read); };
  }, []);
  const change = async (mode: string) => {
    setBusy(true); setError('');
    try { const next = await systemRequest<ComputerAwakeStatus>('computer-awake', { mode }); if (mounted.current) { setStatus(next); window.dispatchEvent(new Event('vade:awake-change')); } }
    catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  };
  return { status, busy, error: error || status?.error, change };
}
export function ComputerAwakeSetting() {
  const awake = useComputerAwake();
  return <div className="settings-page-row settings-dropdown-row"><div><h2>Keep computer awake</h2><p>{awake.error || (awake.status?.active ? 'Sleep prevention is active.' : 'Choose when Vade prevents system sleep.')} Closing Vade releases its sleep blocker.</p></div><Select aria-label="Keep computer awake" value={awake.status?.mode ?? 'off'} disabled={awake.busy || !awake.status} onChange={event => void awake.change(event.target.value)}>{modes.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</Select></div>;
}
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${Math.round(value / 1024 ** 2)} MB`;
const portUrl = (port: WorkspacePort) => `http://${port.address.includes(':') ? '[::1]' : '127.0.0.1'}:${port.port}/`;
let cachedDetails: ResourceDetails | null = null, cachedPorts: WorkspacePorts | null = null, portsReadAt = 0;
let detailsPending: Promise<ResourceDetails> | null = null, portsPending: Promise<WorkspacePorts> | null = null;
function readDetails(): Promise<ResourceDetails> {
  if (!detailsPending) detailsPending = systemRequest<ResourceDetails>('resources/details').then(value => { cachedDetails = value; return value; }).finally(() => { detailsPending = null; });
  return detailsPending;
}
function readPorts(): Promise<WorkspacePorts> {
  if (!portsPending) portsPending = systemRequest<WorkspacePorts>('ports').then(value => { cachedPorts = value; portsReadAt = Date.now(); return value; }).finally(() => { portsPending = null; });
  return portsPending;
}

export function SystemControls({ resources, children }: { resources: AppResources | null; children?: React.ReactNode }) {
  const memory = usePopoverState(), ports = usePopoverState(), awakeMenu = usePopoverState(), awake = useComputerAwake();
  const memoryButton = useRef<HTMLButtonElement>(null), portsButton = useRef<HTMLButtonElement>(null), awakeButton = useRef<HTMLButtonElement>(null);
  const [details, setDetails] = useState<ResourceDetails | null>(cachedDetails), [listeners, setListeners] = useState<WorkspacePorts | null>(cachedPorts), [error, setError] = useState(''), [stopping, setStopping] = useState(false);
  const confirm = useConfirmationState<WorkspacePort>();
  useEffect(() => {
    if (!resources || document.hidden) return;
    let closed = false;
    if (Date.now() - portsReadAt > 15000) void readPorts().then(value => { if (!closed) setListeners(value); }).catch(() => {});
    return () => { closed = true; };
  }, [resources?.observedAt]);
  useEffect(() => {
    if (!memory.present && !ports.present) return;
    const abort = new AbortController(); let busy = false;
    const read = async () => {
      if (busy || document.hidden) return; busy = true;
      try {
        if (memory.present) { const value = await readDetails(); if (!abort.signal.aborted) setDetails(value); }
        if (ports.present) { const value = await readPorts(); if (!abort.signal.aborted) setListeners(value); }
        if (!abort.signal.aborted) setError('');
      } catch (error) { if (!abort.signal.aborted) setError((error as Error).message); } finally { busy = false; }
    };
    void read(); const timer = setInterval(() => void read(), 5000);
    document.addEventListener('visibilitychange', read);
    return () => { abort.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', read); };
  }, [memory.present, ports.present]);
  async function stop() {
    const port = confirm.data; if (!port || stopping) return;
    setStopping(true); setError('');
    try { await systemRequest(`ports/${port.id}/stop`, {}); confirm.close(); setListeners(await readPorts()); }
    catch (error) { setError((error as Error).message); } finally { setStopping(false); }
  }
  return <>
    {children}
    <div className="statusbar-system-controls">
    <button className="statusbar-control" ref={awakeButton} onClick={awakeMenu.toggle} aria-expanded={awakeMenu.present} title="Keep computer awake"><Icon name="coffee" size={14} /><span>{modes.find(mode => mode.id === awake.status?.mode)?.label ?? 'Off'}{awake.status?.active ? ' •' : ''}</span></button>
    <button className="statusbar-control" ref={memoryButton} onClick={memory.toggle} aria-expanded={memory.present} title="Resource Manager"><Icon name="memory" size={14} /><span>{resources ? bytes(resources.memoryBytes) : 'RAM unavailable'}</span></button>
    <button className="statusbar-control" ref={portsButton} onClick={ports.toggle} aria-expanded={ports.present} title="Listening ports"><Icon name="plug" size={14} /><span>{listeners ? listeners.ports.filter(port => port.projectId).length : 'Ports'}</span></button>
    <Popover isOpen={awakeMenu.present} isClosing={awakeMenu.closing} onClose={awakeMenu.close} triggerRef={awakeButton} floating floatingWidth={330} className="system-popover awake-popover"><header><strong>Keep computer awake</strong><span className={`awake-status-badge ${awake.status?.active ? 'is-active' : 'is-inactive'}`}>{awake.status?.active ? 'Active' : 'Inactive'}</span></header>{modes.map(mode => <button key={mode.id} disabled={awake.busy} aria-pressed={awake.status?.mode === mode.id} onClick={() => void awake.change(mode.id)}><span className="awake-mode-mark" aria-hidden="true">{awake.status?.mode === mode.id ? <span className="awake-mode-dot" /> : null}</span><span><strong>{mode.label}</strong><small>{mode.text}</small></span></button>)}{awake.error && <p role="alert" className="text-danger">{awake.error}</p>}</Popover>
    <Popover isOpen={memory.present} isClosing={memory.closing} onClose={memory.close} triggerRef={memoryButton} floating floatingWidth={560} className="system-popover resources-popover"><header><strong>Resource Manager</strong><span>{details ? bytes(details.totalBytes) : 'Loading…'}</span></header><p className="system-popover-note">Observed Vade and owned terminal processes. Browser memory is excluded in web mode. CPU appears after two samples.</p><DialogError error={error} />{!details && <div className="system-skeleton"><div className="skeleton-line" /><div className="skeleton-line" /></div>}{details?.groups.map(group => <Disclosure key={group.id} title={group.label} compact badge={<span className="resource-group-memory">{bytes(group.processes.reduce((sum, row) => sum + row.memoryBytes, 0))}</span>}><table className="resource-table"><thead><tr><th>Process</th><th>CPU</th><th>RAM</th><th>Private</th></tr></thead><tbody>{group.processes.map(row => <tr key={row.pid}><td title={`PID ${row.pid}`}>{row.name} <small>{row.pid}</small></td><td>{row.cpuPercent === null ? '—' : `${row.cpuPercent.toFixed(1)}%`}</td><td>{bytes(row.memoryBytes)}</td><td>{row.privateBytes === null ? '—' : bytes(row.privateBytes)}</td></tr>)}</tbody></table></Disclosure>)}</Popover>
    <Popover isOpen={ports.present} isClosing={ports.closing} onClose={ports.close} triggerRef={portsButton} floating floatingWidth={480} className="system-popover ports-popover"><header><strong>Ports</strong><span>{listeners ? `${listeners.ports.filter(port => port.projectId).length} workspace · ${listeners.ports.filter(port => !port.projectId).length} external` : 'Loading…'}</span></header><DialogError error={error || listeners?.error} />{!listeners && <div className="system-skeleton"><div className="skeleton-line" /><div className="skeleton-line" /></div>}{listeners && !listeners.error && !listeners.ports.length && <p className="system-popover-note">No listening TCP ports found.</p>}{[...new Set(listeners?.ports.map(port => port.project ?? 'External ports') ?? [])].map(group => <Disclosure key={group} title={group} compact defaultOpen={group !== 'External ports'}>{listeners?.ports.filter(port => (port.project ?? 'External ports') === group).map(port => <div className="workspace-port-row" key={port.id}><strong>{port.port}</strong><span>{port.process}<small>{port.address}:{port.port} · PID {port.pid}</small></span><a className="btn btn-xs" href={portUrl(port)} target="_blank" rel="noreferrer" aria-label={`Open port ${port.port} in browser`} title="Open in browser"><Icon name="external-link" size={14} /></a><button className="btn btn-xs" aria-label={`Copy URL for port ${port.port}`} title="Copy URL" onClick={() => void navigator.clipboard.writeText(portUrl(port)).catch(() => setError('Could not copy URL.'))}><Icon name="copy" size={14} /></button><button className="btn btn-xs text-danger" disabled={!port.canKill} title={port.canKill ? 'Stop owning process' : 'Only verified workspace-owned processes can be stopped'} aria-label={`Stop process on port ${port.port}`} onClick={() => { setError(''); confirm.open(port); }}><Icon name="trash" size={14} /></button></div>)}</Disclosure>)}</Popover>
    <Modal isOpen={confirm.present} isClosing={confirm.closing} busy={stopping} onClose={confirm.close} className="confirmation-dialog" aria-labelledby="stop-port-title"><h2 id="stop-port-title">Stop process on port {confirm.data?.port}?</h2><p>This stops {confirm.data?.process} (PID {confirm.data?.pid}) and all listeners owned by that process. Unsaved process state may be lost.</p><DialogError error={error} /><DialogActions onCancel={confirm.close} onConfirm={() => void stop()} busy={stopping} confirmLabel="Stop process" variant="danger" autoFocusCancel /></Modal>
    </div>
  </>;
}
