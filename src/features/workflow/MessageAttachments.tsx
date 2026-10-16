import React, { useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES } from '../../../shared/contracts';

export function validateMessageFiles(files: File[]): string | null {
  if (files.length > MAX_MESSAGE_ATTACHMENTS) return 'Attach up to 8 files.';
  if (files.some((file) => !file.size || file.size > MAX_ATTACHMENT_BYTES)) return 'Files must be non-empty and at most 5 MiB each.';
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) return 'Attachments must total 20 MiB or less.';
  if (files.some((file) => file.type.startsWith('image/') && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))) {
    return 'Images must be PNG, JPEG, GIF, or WebP.';
  }
  return null;
}

function AttachmentPreview({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url ? <img className="message-attachment-preview" src={url} alt="" /> : null;
}

export function MessageAttachments({ files, onChange, disabled, children, renderControls }: {
  files: File[]; onChange: (files: File[]) => void; disabled: boolean; children: React.ReactNode;
  renderControls?: (attachButton: React.ReactNode) => React.ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const add = (incoming: File[]) => {
    if (disabled) return;
    const next = [...files, ...incoming];
    const problem = validateMessageFiles(next);
    setError(problem);
    if (!problem) onChange(next);
  };
  const attachButton = <button type="button" className="btn btn-secondary btn-xs" disabled={disabled} onClick={() => input.current?.click()}>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m21 11-8 8a6 6 0 0 1-8-8L15 1a4 4 0 0 1 6 6L11 17a2 2 0 0 1-3-3l9-9" /></svg>
    Attach
  </button>;
  return (
    <div className="message-attachments"
      onPaste={(event) => {
        const incoming = Array.from(event.clipboardData.files);
        if (incoming.length) { event.preventDefault(); add(incoming); }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; }
      }}
      onDrop={(event) => {
        if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); add(Array.from(event.dataTransfer.files)); }
      }}>
      {files.length > 0 && <ul className="message-attachment-list" aria-label="Attached files">
        {files.map((file, index) => <li key={`${file.name}:${index}`}>
          <AttachmentPreview file={file} />
          <span title={file.name}>{file.name}</span>
          <button type="button" className="btn btn-icon btn-xs" aria-label={`Remove ${file.name}`} disabled={disabled}
            onClick={() => { onChange(files.filter((_, item) => item !== index)); setError(null); }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
          </button>
        </li>)}
      </ul>}
      {children}
      <input ref={input} type="file" multiple hidden aria-label="Choose attachments" disabled={disabled}
          onChange={(event) => { add(Array.from(event.target.files || [])); event.target.value = ''; }} />
      {renderControls ? renderControls(attachButton) : <div className="message-attachment-controls">
        {attachButton}
        <span className="text-xs text-muted">Paste or drop files - 5 MiB each</span>
      </div>}
      {error && <p className="text-danger text-xs" role="alert">{error}</p>}
    </div>
  );
}
