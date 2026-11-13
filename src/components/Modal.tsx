import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Modal({ title, children, onClose, busy = false, closeOnDismiss = true }: {
  title: string; children: ReactNode; onClose: () => void; busy?: boolean; closeOnDismiss?: boolean;
}) {
  const heading = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closing = useRef(onClose);
  closing.current = onClose;
  const working = useRef(busy);
  working.current = busy;
  const dismissible = useRef(closeOnDismiss);
  dismissible.current = closeOnDismiss;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('input, textarea, select, button');
    (first ?? panel.current)?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible.current && !working.current) closing.current();
      if (event.key !== 'Tab') return;
      const items = Array.from(panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
      ) ?? []).filter((el) => el.tabIndex >= 0 && !el.matches('input[type="hidden"], :disabled') && !el.closest('details:not([open]) :not(summary)'));
      if (!items.length) { event.preventDefault(); panel.current?.focus(); return; }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={(e) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    if (closeOnDismiss && !busy) onClose();
  }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby={heading} ref={panel} tabIndex={-1}>
      <header className="modal-heading"><h2 id={heading}>{title}</h2><button className="icon-button" aria-label="ปิดหน้าต่าง" onClick={onClose} disabled={busy}><X size={20} /></button></header>
      {children}
    </div>
  </div>;
}
