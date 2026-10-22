import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountProvider, LocalConnectionsData, ProviderAccount, Section } from '../../../shared/contracts';
import { addProviderAccount, fetchConnections, selectProviderAccount, providerAccountAction, fetchProviderAccounts } from '../../api/client';
import { ProviderIcon } from '../../components/providers/ProviderIcon';
import { RefreshIcon } from '../../components/ui/RefreshIcon';
import { Icon } from '../../components/ui/Icon';
import { Modal } from '../../components/ui/Modal';
import { DialogActions, DialogError } from '../../components/ui/DialogActions';
import { OverlayCloseButton } from '../../components/ui/OverlayCloseButton';
import { useConfirmationState } from '../../hooks/useConfirmationState';

export function ConnectionSettings({ kind }: { kind: 'integrations' | 'accounts' }) {
  const [section, setSection] = useState<Section<LocalConnectionsData> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const busyRef = useRef({ loading, adding });
  busyRef.current = { loading, adding };
  const addDialog = useConfirmationState<AccountProvider>();
  const deleteDialog = useConfirmationState<{ provider: AccountProvider; account: ProviderAccount }>();
  const [deleting, setDeleting] = useState(false);
  const [selectionPending, setSelectionPending] = useState(false);
  busyRef.current.loading = loading || selectionPending;
  const updateAccounts = (provider: AccountProvider, accounts: ProviderAccount[]) => setSection(previous => previous?.data ? { ...previous, data: { ...previous.data, connections: previous.data.connections.map(c => c.id === provider ? { ...c, accounts } : c) } } : previous);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setLoading(true);
    try { const data = await fetchConnections(abort.signal); if (!abort.signal.aborted) { setSection(data); setError(null); } }
    catch { if (!abort.signal.aborted) setError('Could not detect local connections. Re-check to retry.'); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const usageUpdated = () => { if (kind === 'accounts' && !busyRef.current.adding && !busyRef.current.loading) void refresh(); };
    window.addEventListener('ade:usage-updated', usageUpdated);
    return () => { request.current?.abort(); window.removeEventListener('ade:usage-updated', usageUpdated); };
  }, [refresh, kind]);
  const copy = async (id: string, command: string) => {
    try { await navigator.clipboard.writeText(command); setCopied(id); }
    catch { setError('Clipboard unavailable. Select and copy the command below.'); }
  };
  const select = async (provider: AccountProvider, account: ProviderAccount) => {
    if (loading || selectionPending || account.active) return;
    const abort = new AbortController(); request.current?.abort(); request.current = abort;
    setSelectionPending(true);
    const previous = section?.data?.connections.find(c => c.id === provider)?.accounts ?? [];
    updateAccounts(provider, previous.map(a => ({ ...a, active: a.id === account.id })));
    try {
      const next = await selectProviderAccount(provider, account.id, abort.signal);
      if (!abort.signal.aborted) { updateAccounts(provider, next); setError(null); window.dispatchEvent(new Event('ade:usage-account-change')); }
    } catch { if (!abort.signal.aborted) { updateAccounts(provider, previous); setError('Selection could not be confirmed. Re-check before trying again.'); } }
    finally { if (!abort.signal.aborted) setSelectionPending(false); }
  };
  const add = async () => {
    const provider = addDialog.data;
    if (!provider || adding || !name.trim()) return;
    setAdding(true); setAddError(null);
    const previous = new Set(section?.data?.connections.find(c => c.id === provider)?.accounts?.map(a => a.id));
    const abort = new AbortController(); request.current?.abort(); request.current = abort;
    try {
      const next = await addProviderAccount(provider, { label: name.trim() }, abort.signal);
      if (!abort.signal.aborted) {
        updateAccounts(provider, next);
        const account = next.find(a => !previous.has(a.id));
        addDialog.close();
        if (account) {
          setExpanded(`${provider}:${account.id}`);
          try { updateAccounts(provider, await providerAccountAction(provider, 'login', account.id, abort.signal)); }
          catch { if (!abort.signal.aborted) setError('Account created. Could not start sign-in; install the provider CLI and use Sign in below.'); }
        }
      }
    } catch { if (!abort.signal.aborted) setAddError('Account creation could not be confirmed. Re-check the account list before adding again.'); }
    finally { if (!abort.signal.aborted) setAdding(false); }
  };
  const hasPendingLogin = section?.data?.connections.some(c => c.accounts?.some(a => a.signIn?.state === 'pending'));
  useEffect(() => {
    if (!hasPendingLogin) return;
    const abort = new AbortController(); let busy = false;
    const timer = window.setInterval(async () => {
      if (busy) return; busy = true;
      try { for (const provider of ['codex', 'claude'] as const) { const accounts = await fetchProviderAccounts(provider, abort.signal); if (!abort.signal.aborted) updateAccounts(provider, accounts); } } catch { /* Preserve sign-in state; explicit re-check remains available. */ }
      finally { busy = false; }
    }, 1500);
    return () => { clearInterval(timer); abort.abort(); };
  }, [hasPendingLogin]);
  const remove = async () => {
    if (!deleteDialog.data || deleting) return;
    setDeleting(true); setError(null);
    try { const { provider, account } = deleteDialog.data; updateAccounts(provider, await providerAccountAction(provider, 'delete', account.id)); deleteDialog.close(); window.dispatchEvent(new Event('ade:usage-account-change')); }
    catch { setError('Account deletion could not be confirmed. Re-check the account list.'); }
    finally { setDeleting(false); }
  };
  const connections = section?.data?.connections.filter(c => kind === 'integrations' ? c.id === 'github' : c.id !== 'github') ?? [];
  const host = section?.data?.host ?? 'local';
  return <div className="connection-settings">
    <div className="connection-settings-toolbar"><span>Account scope: Local {host}</span><button className="btn btn-secondary btn-sm" disabled={loading || adding} onClick={() => void refresh()}><RefreshIcon busy={loading} size={13} />Re-check</button></div>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {loading && !section && <p role="status">Detecting local connections…</p>}
    {connections.map(connection => {
      const managed = connection.id === 'codex' || connection.id === 'claude';
      const accounts = connection.accounts ?? [{ id: 'system', label: 'System default', active: true, detected: connection.connected, loginCommand: connection.loginCommand }];
      const instruction = accounts.find(a => `${connection.id}:${a.id}` === expanded);
      const active = accounts.find(a => a.active);
      return <section key={connection.id} className="connection-card" aria-label={connection.label}>
        <div className="connection-card-heading">{connection.id === 'github' ? <Icon name="git-branch" size={22} /> : <ProviderIcon provider={connection.id} size={22} />}<h2>{connection.label}</h2>
          <span className={`connection-badge ${connection.connected && connection.installed ? 'is-connected' : 'is-undetected'}`}>{connection.connected && connection.installed ? 'Active' : 'Not Active'}</span>
        </div>
        <p>{kind === 'integrations' ? 'Pull requests, issues, and commits through the GitHub CLI.' : 'Choose the account used to display subscription usage.'}</p>
        {kind === 'accounts' && <>
          <div className="connection-accounts-heading"><div><strong>Accounts</strong><p>Showing accounts for {host}.</p></div>
            {managed && <button className="btn btn-secondary btn-sm" disabled={loading || adding} onClick={() => { setName(''); setAddError(null); addDialog.open(connection.id as AccountProvider); }}><Icon name="plus" size={13} />Add account</button>}
          </div>
          <div role="radiogroup" aria-label={`${connection.label} usage account`} className="connection-account-list">
            {accounts.map(account => <div className="connection-account-option" key={account.id}>
              <label className={`connection-account-choice ${account.active ? 'is-active' : ''}`}>
                <input type="radio" name={`${connection.id}-account`} checked={account.active} disabled={loading || selectionPending || !managed} onChange={() => void select(connection.id as AccountProvider, account)} aria-label={`${connection.label}: ${account.label}`} />
                <span className="connection-account-copy"><span className="connection-account-name">{account.label}<span className={`connection-active-tag ${account.active ? '' : 'is-inactive'}`}>{account.active ? 'Active' : 'Not Active'}</span></span>
                  <span className="connection-account-description">{account.id === 'system' ? `Use your current ${host} ${connection.label} login.` : `Separate ${connection.label} sign-in for usage display.`}</span>
                </span>
              </label>
              {managed && <button type="button" className="btn-icon connection-account-signin" aria-label={`Sign-in instructions for ${connection.label}: ${account.label}`} title="Sign-in instructions" onClick={() => setExpanded(expanded === `${connection.id}:${account.id}` ? null : `${connection.id}:${account.id}`)}><Icon name="terminal" size={14} /></button>}
              {managed && account.id !== 'system' && <button type="button" className="btn-icon connection-account-delete" aria-label={`Delete account ${account.label}`} disabled={account.signIn?.state === 'pending'} onClick={() => deleteDialog.open({ provider: connection.id as AccountProvider, account })}><Icon name="trash" size={14} /></button>}
            </div>)}
          </div>
        </>}
        {kind === 'integrations' && <p>{connection.message}</p>}
        <div className="connection-actions">
          {!connection.installed && <a className="btn btn-secondary btn-sm" href={connection.installUrl} target="_blank" rel="noreferrer"><Icon name="external-link" size={13} />Install {connection.label}{connection.id === 'github' ? ' CLI' : ''}</a>}
          {connection.installed && <button className="btn btn-secondary btn-sm" aria-expanded={Boolean(instruction)} onClick={() => setExpanded(instruction ? null : `${connection.id}:${active?.id ?? 'system'}`)}><Icon name="terminal" size={14} />Sign-in instructions</button>}
        </div>
        {instruction && <div className="connection-login">
          <strong>{instruction.label}</strong>
          {managed && instruction.id !== 'system' && <div className="connection-oauth"><p role="status">{instruction.signIn?.state === 'pending' ? 'Waiting for browser sign-in…' : instruction.signIn?.state === 'complete' ? 'Sign-in complete. You can select this account.' : instruction.signIn?.state === 'failed' ? 'Sign-in did not finish. Try again when ready.' : 'Sign in through your provider’s browser authorization.'}</p>{instruction.signIn?.url && instruction.signIn.state === 'pending' && <a className="btn btn-secondary btn-sm" href={instruction.signIn.url} target="_blank" rel="noreferrer">Open sign-in page<Icon name="external-link" size={13} /></a>}{instruction.signIn?.state !== 'pending' && <button className="btn btn-secondary btn-sm" onClick={() => { void providerAccountAction(connection.id as AccountProvider, 'login', instruction.id).then(accounts => updateAccounts(connection.id as AccountProvider, accounts)).catch(() => setError('Could not start sign-in. Check that the provider CLI is installed.')); }}>Sign in with {connection.label}</button>}</div>}
          <p>Run this {host === 'Windows' ? 'PowerShell ' : ''}command on the ADE host and complete the provider’s sign-in. Then re-check and select the account above.</p>
          <code>{instruction.loginCommand}</code><button className="btn btn-secondary btn-sm" onClick={() => void copy(`${connection.id}:${instruction.id}`, instruction.loginCommand)}><Icon name="terminal" size={13} />{copied === `${connection.id}:${instruction.id}` ? 'Copied' : 'Copy sign-in command'}</button>
        </div>}
      </section>;
    })}
    <Modal isOpen={addDialog.present} isClosing={addDialog.closing} busy={adding} onClose={addDialog.close} className="provider-account-dialog" aria-labelledby="add-provider-account-title">
      <div className="connection-card-heading"><h2 id="add-provider-account-title">Add {addDialog.data === 'claude' ? 'Claude Code' : 'Codex'} account</h2><OverlayCloseButton onClick={addDialog.close} disabled={adding} /></div>
      <p>Create an account profile and complete the provider’s browser sign-in. Selection changes usage display; running agents keep their existing accounts.</p>
      <form onSubmit={event => { event.preventDefault(); void add(); }}><label className="worktree-field">Account name<input autoFocus maxLength={60} value={name} disabled={adding} onChange={event => setName(event.target.value)} placeholder="e.g. Personal" /></label></form>
      <DialogError error={addError} /><DialogActions onCancel={addDialog.close} onConfirm={add} busy={adding} disabled={!name.trim()} confirmLabel="Create account" busyLabel="Creating…" />
    </Modal>
    <Modal isOpen={deleteDialog.present} isClosing={deleteDialog.closing} busy={deleting} onClose={deleteDialog.close} className="confirmation-dialog" aria-labelledby="delete-account-title"><h2 id="delete-account-title">Delete account?</h2><p>Remove “{deleteDialog.data?.account.label}” and its saved sign-in from ADE? If selected, usage returns to System default.</p><DialogActions onCancel={deleteDialog.close} onConfirm={remove} busy={deleting} variant="danger" autoFocusCancel confirmLabel="Delete account" busyLabel="Deleting…" /></Modal>
  </div>;
}
