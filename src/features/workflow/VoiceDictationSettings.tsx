import { useEffect, useRef, useState } from 'react';
import type { LocalSpeechCatalog, LocalSpeechModel } from '../../../shared/contracts';
import { speechRequest } from '../../api/client';
import { Icon } from '../../components/ui/Icon';
import { Select } from '../../components/ui/Select';
import { Popover } from '../../components/ui/Popover';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { usePopoverState } from '../../hooks/usePopoverState';
import { updateVoicePreferences, useVoicePreferences } from './voicePreferences';

export function VoiceDictationSettings() {
  const preferences = useVoicePreferences();
  const [catalog, setCatalog] = useState<LocalSpeechCatalog | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState('');
  const [micBusy, setMicBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const overlay = usePopoverState(), trigger = useRef<HTMLButtonElement>(null);
  const desktop = typeof window !== 'undefined' && Boolean(window.adeDesktop);
  const selected = catalog?.models.find(model => model.id === preferences.modelId);
  useEffect(() => { if (!preferences.enabled) overlay.close(); }, [preferences.enabled, overlay.close]);
  useEffect(() => {
    const controller = new AbortController();
    const read = () => { void speechRequest<LocalSpeechCatalog>('models', undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) setCatalog(value);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }); };
    read();
    return () => controller.abort();
  }, []);
  const downloading = catalog?.models.some(model => model.status === 'downloading');
  useEffect(() => {
    if (!downloading) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void speechRequest<LocalSpeechCatalog>('models', undefined, controller.signal).then(value => { if (!controller.signal.aborted) setCatalog(value); })
        .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    }, 1000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [downloading]);
  useEffect(() => {
    let disposed = false;
    const read = () => { void navigator.mediaDevices?.enumerateDevices().then(items => { if (!disposed) setDevices(items.filter(item => item.kind === 'audioinput' && item.deviceId !== 'default' && item.deviceId !== 'communications')); }).catch(() => {}); };
    read(); navigator.mediaDevices?.addEventListener('devicechange', read);
    return () => { disposed = true; navigator.mediaDevices?.removeEventListener('devicechange', read); };
  }, []);
  const refreshMicrophones = async () => {
    setError(''); setMicBusy(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires localhost or HTTPS.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter(item => item.kind === 'audioinput' && !['default', 'communications'].includes(item.deviceId)));
    } catch { setError('Microphone access was denied or no microphone is available. Check system microphone permissions.'); }
    finally { setMicBusy(false); }
  };
  const download = async (model: LocalSpeechModel) => {
    setModelBusy(true); setError('');
    try { setCatalog(await speechRequest<LocalSpeechCatalog>(`models/${model.id}/${model.status === 'downloading' ? 'cancel' : 'download'}`, {})); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Model download failed'); }
    finally { setModelBusy(false); }
  };
  return <section className="voice-settings" aria-label="Voice dictation settings">
    <label className="settings-page-row"><div><h2>Enable voice dictation</h2><p>Use Dictate or Ctrl+E to add speech to the focused Chat draft.</p></div><input type="checkbox" role="switch" checked={preferences.enabled} onChange={event => updateVoicePreferences({ enabled: event.target.checked })} /></label>
    {preferences.enabled && <>
    <label className="settings-page-row"><div><h2>Speech engine</h2><p>{desktop ? 'Local recognition works offline in the desktop app. Browser speech recognition is unavailable in Electron.' : 'Browser uses your browser’s speech service. Local processes audio on the computer running Vade.'}</p></div><Select aria-label="Speech engine" value={preferences.engine} onChange={event => updateVoicePreferences({ engine: event.target.value as 'browser' | 'local' })}><option value="browser" disabled={desktop}>Browser</option><option value="local">Local (offline)</option></Select></label>
    <div className="settings-page-row"><div><h2>Dictation mode</h2><p>Toggle: press Ctrl+E to start and stop. Hold: keep Ctrl+E pressed while speaking.</p></div><SegmentedControl label="Dictation mode" choices={[{ value: 'toggle', label: 'Toggle' }, { value: 'hold', label: 'Hold' }]} value={preferences.mode} onChange={mode => updateVoicePreferences({ mode: mode as 'toggle' | 'hold' })} /></div>
    <div className="settings-page-row"><div><h2>Microphone</h2><p>{preferences.engine === 'browser' ? 'Browser speech recognition uses the system microphone.' : 'System default follows your operating system’s microphone setting.'}</p></div><div className="voice-microphone-controls"><Select aria-label="Microphone" disabled={preferences.engine === 'browser'} value={preferences.deviceId} onChange={event => updateVoicePreferences({ deviceId: event.target.value })}><option value="default">System default</option>{devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}{preferences.deviceId !== 'default' && !devices.some(device => device.deviceId === preferences.deviceId) && <option value={preferences.deviceId}>Previously selected microphone (unavailable)</option>}</Select><button type="button" className="voice-microphone-refresh" disabled={micBusy || preferences.engine === 'browser'} onClick={() => void refreshMicrophones()} aria-label="Refresh microphones" title="Refresh microphones" aria-busy={micBusy}><Icon name="refresh-cw" size={16} className={`refresh-icon${micBusy ? ' spin' : ''}`} /></button></div></div>
    {preferences.engine === 'local' && <div className="settings-page-row"><div><h2>Speech model</h2><p>Download once, then transcribe offline. Audio is not saved or sent to a speech service.</p></div><div className="custom-select-control voice-model-control"><button ref={trigger} type="button" className="custom-select-native" onClick={overlay.toggle} aria-haspopup="dialog" aria-label="Speech model" aria-expanded={overlay.present && !overlay.closing}>{selected?.status === 'ready' ? selected.label : 'Select model'}</button><Icon name="chevron-down" size={12} className="custom-select-arrow" /></div>
      <Popover isOpen={overlay.present} isClosing={overlay.closing} onClose={overlay.close} triggerRef={trigger} floating floatingWidth={450} portal className="voice-model-popover" aria-label="Local speech models">
        {!catalog && <p role="status">Loading speech models…</p>}
        {catalog && !catalog.available && <p className="panel-alert alert-error" role="alert">{catalog.reason}</p>}
        {catalog?.models.map(model => <div className="voice-model-row" key={model.id}>
          <button className="voice-model-choice" type="button" disabled={model.status !== 'ready'} title={model.status !== 'ready' ? 'Download this model before selecting it' : undefined} aria-pressed={preferences.modelId === model.id} onClick={() => { updateVoicePreferences({ modelId: model.id }); overlay.close(); }}><span><strong>{model.label}</strong><small>{model.streaming ? 'Streaming' : 'Offline'} · {Math.round(model.sizeBytes / 1000000)} MB{model.recommended && <span className="voice-model-recommended">Recommended</span>}</small><span>{model.description}</span></span>{preferences.modelId === model.id && <Icon name="check" size={16} />}</button>
          {model.status === 'ready' ? <span className="voice-model-ready">Downloaded</span> : <button type="button" className="btn btn-secondary btn-sm" disabled={modelBusy || !catalog.available || (downloading && model.status !== 'downloading')} onClick={() => void download(model)}><Icon name={model.status === 'downloading' ? 'close' : 'download'} size={13} />{model.status === 'downloading' ? 'Cancel' : model.status === 'error' ? 'Retry download' : 'Download'}</button>}
          {model.status === 'downloading' && <div className="voice-model-progress"><progress max={model.sizeBytes} value={model.downloadedBytes} aria-label={`${model.label} download progress`} /><span>{Math.min(100, Math.floor(model.downloadedBytes / model.sizeBytes * 100))}%</span></div>}
          {model.error && <p className="panel-alert alert-error" role="alert">{model.error}</p>}
        </div>)}
      </Popover>
    </div>}
    {selected && preferences.engine === 'local' && selected.status !== 'ready' && <p className="voice-settings-note">{selected.status === 'downloading' ? `Downloading ${selected.label}: ${Math.floor(selected.downloadedBytes / selected.sizeBytes * 100)}%` : `${selected.label} needs to be downloaded. Open Speech model to download it.`}</p>}
    {error && <p className="panel-alert alert-error" role="alert">{error}</p>}
    </>}
  </section>;
}
