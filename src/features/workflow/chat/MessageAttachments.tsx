import React, { useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES } from '../../../../shared/contracts';
import { Icon } from '../../../components/ui/Icon';

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function validateMessageFiles(files: File[]): string | null {
  if (files.length > MAX_MESSAGE_ATTACHMENTS) return 'Attach up to 8 files.';
  if (files.some((file) => !file.size || file.size > MAX_ATTACHMENT_BYTES)) return 'Files must be non-empty and at most 5 MiB each.';
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) return 'Attachments must total 20 MiB or less.';
  if (files.some((file) => file.type.startsWith('image/') && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))) {
    return 'Images must be PNG, JPEG, GIF, or WebP.';
  }
  return null;
}

export function AttachmentPreview({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file.type.startsWith('image/')) return;
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  return url ? <img className="message-attachment-preview" src={url} alt="" /> : null;
}

export function MessageAttachments({ files, onChange, disabled, children, renderControls, iconOnly=false }: {
  files: File[]; onChange: (files: File[]) => void; disabled: boolean; children: React.ReactNode;
  renderControls?: (attachButton: React.ReactNode) => React.ReactNode;
  iconOnly?:boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const add = (incoming: File[]) => {
    if (disabled) return;
    const next = [...files, ...incoming];
    const problem = validateMessageFiles(next);
    setError(problem);
    if (!problem) onChange(next);
  };
  const attachButton = <button type="button" className={`btn btn-secondary btn-xs ${iconOnly?'composer-attach-icon':''}`} aria-label="Attach files" title="Attach files" disabled={disabled} onClick={() => input.current?.click()}>
    <Icon name={iconOnly?'plus':'paperclip'} size={iconOnly?18:12} />
    {!iconOnly&&<span className="composer-action-label">Attach</span>}
  </button>;
  return (
    <div className={`message-attachments${dragOver ? ' is-drag-over' : ''}`}
      onPaste={(event) => {
        const incoming = Array.from(event.clipboardData.files);
        if (incoming.length) { event.preventDefault(); add(incoming); }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
          if (!disabled && !dragOver) setDragOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragOver(false);
        }
      }}
      onDrop={(event) => {
        setDragOver(false);
        if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); add(Array.from(event.dataTransfer.files)); }
      }}>
      {files.length > 0 && <ul className="message-attachment-list" aria-label="Attached files">
        {files.map((file, index) => <li key={`${file.name}:${index}`}>
          {file.type.startsWith('image/') ? <AttachmentPreview file={file} /> : <span className="message-attachment-file-icon" aria-hidden="true"><Icon name="paperclip" size={12} /></span>}
          <span className="message-attachment-name" title={file.name}>{file.name}</span>
          {file.size > 0 && <small className="message-attachment-size">{formatAttachmentSize(file.size)}</small>}
          <button type="button" className="btn btn-icon btn-xs" aria-label={`Remove ${file.name}`} disabled={disabled}
            onClick={() => { onChange(files.filter((_, item) => item !== index)); setError(null); }}>
            <Icon name="close" size={12} />
          </button>
        </li>)}
      </ul>}
      {children}
      <input ref={input} type="file" multiple hidden aria-label="Choose attachments" disabled={disabled}
          onChange={(event) => { add(Array.from(event.target.files || [])); event.target.value = ''; }} />
      {renderControls ? renderControls(attachButton) : <div className="message-attachment-controls">
        {attachButton}
      </div>}
      {error && <p className="message-attachment-error text-danger text-xs" role="alert">{error}</p>}
    </div>
  );
}
