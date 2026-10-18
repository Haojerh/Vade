import { useCallback } from 'react';
import { useConfirmationState } from './useConfirmationState';

export function usePopoverState() {
  const { present, closing, close, open } = useConfirmationState();
  const toggle = useCallback(() => {
    if (present && !closing) close();
    else open();
  }, [present, closing, close, open]);
  return { present, closing, close, toggle };
}
