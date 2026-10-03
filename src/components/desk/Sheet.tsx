// Right-side panel used for details and secondary flows (account details, sign-in).
// Escape and the scrim close it; focus is trapped while open.

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useDialogFocusTrap } from '../useDialogFocusTrap';

type SheetProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  wide?: boolean;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
};

export function Sheet({ title, subtitle, wide = false, onClose, footer, children }: SheetProps) {
  const ref = useDialogFocusTrap<HTMLElement>({ active: true, onEscape: onClose });
  return (
    <>
      <div className="d-scrim" onClick={onClose} />
      <aside ref={ref} className={`d-sheet${wide ? ' d-wide' : ''}`} role="dialog" aria-modal="true" tabIndex={-1}>
        <div className="d-sheet-h">
          <div>
            <h3>{title}</h3>
            {subtitle ? <div className="d-t3">{subtitle}</div> : null}
          </div>
          <button type="button" className="d-iconbtn" aria-label="Close" onClick={onClose}>
            <X className="d-icon" aria-hidden="true" />
          </button>
        </div>
        <div className="d-sheet-body">{children}</div>
        {footer ? <div className="d-sheet-f">{footer}</div> : null}
      </aside>
    </>
  );
}
