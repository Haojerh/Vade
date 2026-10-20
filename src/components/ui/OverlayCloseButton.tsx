import type { ButtonHTMLAttributes } from 'react';
import { Icon } from './Icon';

export function OverlayCloseButton({ className = '', 'aria-label': label = 'Close dialog', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} type="button" className={`btn-close overlay-close-button ${className}`} aria-label={label} title={label}>
    <Icon name="close" size={18} />
  </button>;
}
