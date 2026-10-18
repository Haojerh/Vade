import type { SelectHTMLAttributes } from 'react';
import { Icon } from './Icon';

export function Select({ className = '', wrapperClassName = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }) {
  return <div className={`custom-select-control ${wrapperClassName}`}>
    <select {...props} className={`custom-select-native ${className}`}>{children}</select>
    <Icon name="chevron-down" size={12} className="custom-select-arrow" />
  </div>;
}
