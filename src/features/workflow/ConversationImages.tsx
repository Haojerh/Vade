import React, { useState } from 'react';
import type { ConversationImage } from '../../../shared/contracts';
import { Icon } from '../../components/ui/Icon';
import { Modal } from '../../components/ui/Modal';
import { useConfirmationState } from '../../hooks/useConfirmationState';

/** Same-origin route for one recorded image. The browser only ever sees opaque tokens:
 *  the backend re-reads the exact bound record and never exposes a host path or remote URL. */
export function conversationImageUrl(projectId: string, nodeId: string, source: string, image: ConversationImage): string {
  const query = new URLSearchParams({ source, id: image.id });
  return `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/conversation-image?${query.toString()}`;
}

export function conversationImageLabel(index: number, total: number): string {
  return total > 1 ? `Your image ${index + 1} of ${total}` : 'Your image';
}

/** Recorded user image attachments for one exact conversation turn. Missing or rejected
 *  bytes degrade to a plain notice; nothing is fabricated and no preview is fetched twice. */
export function ConversationImages({ projectId, nodeId, source, images }: {
  projectId: string; nodeId: string; source: string; images?: ConversationImage[];
}) {
  const lightbox = useConfirmationState<number>();
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  if (!images?.length) return null;
  const active = lightbox.data === null ? null : images[lightbox.data];
  const activeUrl = active ? conversationImageUrl(projectId, nodeId, source, active) : null;
  return <>
    <ul className="conversation-images" aria-label="Attached images">
      {images.map((image, index) => {
        const url = conversationImageUrl(projectId, nodeId, source, image);
        const label = conversationImageLabel(index, images.length);
        if (failed.has(image.id)) return <li key={image.id}>
          <span className="conversation-image-unavailable" role="note">
            <Icon name="alert-circle" size={13} />
            <span>Image unavailable</span>
          </span>
        </li>;
        return <li key={image.id}>
          <button type="button" className="conversation-image-button" aria-label={`Open ${label.toLowerCase()}`}
            onClick={() => lightbox.open(index)}>
            <img className="conversation-image" src={url} alt={label} loading="lazy" decoding="async"
              onError={() => setFailed(current => new Set(current).add(image.id))} />
          </button>
        </li>;
      })}
    </ul>
    <Modal isOpen={lightbox.present} isClosing={lightbox.closing} onClose={lightbox.close} className="conversation-image-dialog" aria-label="Attached image preview">
          <button type="button" className="conversation-image-close" aria-label="Close image preview" onClick={lightbox.close}>
            <Icon name="close" size={20} />
          </button>
        {activeUrl && <img className="conversation-image-full" src={activeUrl} alt={conversationImageLabel(lightbox.data ?? 0, images.length)} />}
    </Modal>
  </>;
}
