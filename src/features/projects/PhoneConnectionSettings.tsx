import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { PhoneConnectionSettings as Settings, PhoneSetupTerminal } from '../../../shared/contracts';
import { DialogError } from '../../components/ui/DialogActions';
import { Icon } from '../../components/ui/Icon';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { ConfirmationDialog } from '../../components/ui/ConfirmationDialog';
import { useConfirmationState } from '../../hooks/ui/useConfirmationState';
import './phoneConnection.css';

const AgentTerminal = lazy(() => import('../workflow/terminal/AgentTerminal').then(module => ({ default: module.AgentTerminal })));

export function PhoneConnectionSettings() {
  const desktop = window.adeDesktop;
  const disableAccess = useConfirmationState();
  const [saved, setSaved] = useState<Settings | null>(null), [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false), [opening, setOpening] = useState(false), [checking, setChecking] = useState(false);
  const [error, setError] = useState(''), [copied, setCopied] = useState(false), [notice, setNotice] = useState('');
  const [terminal, setTerminal] = useState<PhoneSetupTerminal | null>(null);
  const mounted = useRef(true), owner = useRef<PhoneSetupTerminal | null>(null);
  useEffect(() => {
    mounted.current = true;
    desktop?.phoneStatus().then(value => { if (mounted.current) { setSaved(value); setAddress(value.origin); } }).catch(reason => { if (mounted.current) setError(String(reason)); });
    return () => { mounted.current = false; if (owner.current) void desktop?.closePhoneSetup(owner.current).catch(() => {}); };
  }, [desktop]);
  const save = async (enabled: boolean) => {
    if (!desktop || busy) return false;
    setBusy(true); setError(''); setCopied(false);
    try { const value = await desktop.savePhone({ enabled, origin: enabled ? address.trim() : saved?.origin ?? '' }); if (mounted.current) { setSaved(value); setAddress(value.origin); } return true; }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); return false; }
    finally { if (mounted.current) setBusy(false); }
  };
  const openSetup = async () => {
    if (!desktop) return;
    setOpening(true); setError(''); setNotice('');
    try { const next = await desktop.setupPhone(); owner.current = next; if (mounted.current) setTerminal(next); else void desktop.closePhoneSetup(next).catch(() => {}); }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setOpening(false); }
  };
  const check = async () => {
    if (!desktop) return;
    setChecking(true); setError(''); setNotice('');
    try {
      const detected = await desktop.detectPhone();
      if (mounted.current) { if (detected) { setAddress(detected); setNotice('Connection found. Enable access below, then open the link on your phone.'); } else setNotice('No private connection to Vade found yet. Finish the terminal setup, or paste the HTTPS address from Tailscale Serve below.'); }
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setChecking(false); }
  };
  const working = busy || opening || checking;
  return <section className="phone-connection" aria-label="Phone connection">
    <div className="phone-connection-summary"><span className="phone-connection-symbol"><Icon name="phone" size={24} /></span><div><h2>Your workspace, on your phone</h2><p>Use the same agents, chats and files over your private Tailscale network.</p></div><span className={`phone-connection-badge${saved?.enabled ? ' is-enabled' : ''}`}>{saved?.enabled ? 'Access enabled' : 'Access off'}</span></div>
    <div className="phone-connection-install"><span>New to Tailscale? Install it on your laptop and phone, then sign in to the same network.</span><a href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Download Tailscale<Icon name="external-link" size={12} /></a><a href="https://tailscale.com/docs/install" target="_blank" rel="noopener noreferrer">Installation guide<Icon name="external-link" size={12} /></a></div>
    {!desktop ? <p className="phone-connection-browser">Set up this connection in the Vade desktop app on your laptop.</p> : <>
      <div className="phone-connection-step"><span className="phone-connection-number" aria-hidden="true">1</span><div className="phone-connection-step-body"><h3>Set up Tailscale</h3><p>Connect Tailscale on your laptop and phone. Click Set up connection, then press Enter in the terminal to run the command.</p><div className="phone-connection-actions"><button type="button" className="btn btn-secondary" disabled={working || !saved} onClick={() => void openSetup()}><Icon name="terminal" size={15} />{opening ? 'Opening terminal…' : terminal ? 'Reopen setup terminal' : 'Set up connection'}</button><button type="button" className="btn btn-secondary" disabled={working || !saved} onClick={() => void check()}><RefreshIcon busy={checking} size={14} />Check connection</button></div>
        {terminal && <div className="phone-connection-terminal"><div className="phone-connection-terminal-heading"><span><Icon name="terminal" size={14} />Tailscale setup</span><button type="button" className="btn-icon" aria-label="Close setup terminal" onClick={() => { void desktop.closePhoneSetup(terminal).catch(reason => setError(String(reason))); owner.current = null; setTerminal(null); }}><Icon name="close" size={14} /></button></div><p>Press Enter to run the command. If Tailscale asks you to enable HTTPS, open its link and finish the setup.</p><Suspense fallback={<p>Opening terminal…</p>}><AgentTerminal setupLabel="Tailscale setup" projectId={terminal.projectId} nodeId={terminal.nodeId} streamPath={`/api/phone/setup-terminal/${terminal.projectId}/${terminal.nodeId}/terminal-stream`} /></Suspense></div>}
      </div></div>
      <div className="phone-connection-step"><span className="phone-connection-number" aria-hidden="true">2</span><div className="phone-connection-step-body"><h3>Open Vade on your phone</h3><p>Paste the HTTPS link printed after the command runs in the terminal. Or click Check connection to fill it in automatically. Then enable access and open that link on your phone.</p><label className="worktree-field">Phone link<input type="url" placeholder="https://your-laptop.your-tailnet.ts.net" value={address} disabled={working || !saved} onChange={event => { setAddress(event.target.value); setCopied(false); }} autoComplete="off" spellCheck={false} /></label><div className="phone-connection-actions"><button type="button" className="btn btn-primary" disabled={working || !saved || !address.trim()} onClick={() => void save(true)}><Icon name={saved?.enabled ? 'check' : 'phone'} size={15} />{busy ? 'Applying…' : saved?.enabled ? 'Save link' : 'Enable phone access'}</button>{saved?.enabled && <><button type="button" className="btn btn-secondary" disabled={working} onClick={() => void navigator.clipboard.writeText(saved.origin).then(() => setCopied(true)).catch(() => setError('Could not copy the link. Select and copy it above.'))}><Icon name={copied ? 'check' : 'copy'} size={14} />{copied ? 'Copied' : 'Copy link'}</button><button type="button" className="btn btn-danger" disabled={working} onClick={() => { setError(''); disableAccess.open(); }}>Disable access</button></>}</div><p className="phone-connection-notice" role="status">{notice || (saved?.enabled ? 'Open the saved link in your phone’s browser with Tailscale connected.' : !saved ? 'Reading connection settings…' : 'Your workspace stays local until you enable access.')}</p></div></div>
    </>}
    <ConfirmationDialog isOpen={disableAccess.present} isClosing={disableAccess.closing} title="Disable phone access?" description="Your phone will lose access to this workspace and its open terminal connections will disconnect. Agents will keep running on your laptop. You can enable access again later." confirmLabel="Disable access" confirmVariant="danger" isConfirming={busy} error={error} onClose={() => { if (!busy) disableAccess.close(); }} onConfirm={async () => { if (await save(false)) disableAccess.close(); }} />
    {!disableAccess.present && <DialogError error={error} />}
    <p className="phone-connection-footnote">Keep Vade running and your laptop awake. Devices allowed by your Tailscale rules can control this workspace. Use Serve with Funnel off.</p>
  </section>;
}
