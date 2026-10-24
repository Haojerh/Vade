import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import './actionNotice.css';

export function ActionNotice({children,closing,onClose,label='Dismiss action message'}:{children:ReactNode;closing:boolean;onClose:()=>void;label?:string}){
  return createPortal(<div className={`action-notice ${closing?'is-closing':''}`} role="status" inert={closing}>
    {children}<button className="btn-icon" aria-label={label} onClick={onClose}><Icon name="close" size={12}/></button>
  </div>,document.body);
}
