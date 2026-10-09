import { ArrowUpToLine, Check, Copy, Eye, EyeOff, GripVertical, MoreHorizontal, QrCode, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AccountCode } from '../types';

function ProviderIcon({ name }: { name: string }) {
  const tone = /google|gmail/i.test(name) ? 'google' : /microsoft|outlook|office|azure/i.test(name) ? 'microsoft' : /github/i.test(name) ? 'github' : /facebook/i.test(name) ? 'facebook' : 'other';
  return <span className={`provider-icon ${tone}`} aria-hidden="true">{tone === 'microsoft' ? <><i /><i /><i /><i /></> : tone === 'github' ? 'GH' : tone === 'facebook' ? 'f' : tone === 'google' ? 'G' : Array.from(name)[0]?.toUpperCase()}</span>;
}

export function AccountRow({ account, copied, preview, onCopy, onDelete, onExport, onMoveTop, onDragStart, onReorderKey, moving = false, dragging = false, dropTarget = false }: {
  account: AccountCode; copied: boolean; preview: boolean;
  onCopy: () => void; onDelete: () => void; onExport: () => void;
  onMoveTop?: () => void; onDragStart?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onReorderKey?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  moving?: boolean; dragging?: boolean; dropTarget?: boolean;
}) {
  const [hidden, setHidden] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const name = account.issuer || account.account;
  const label = `${name} ${account.account}`;
  const code = (hidden ? '•'.repeat(account.digits) : account.code).replace(new RegExp(`(.{${account.digits / 2}})`), '$1 ');
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (e: PointerEvent) => { if (!menu.current?.contains(e.target as Node)) setMenuOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);
  return <article className={`account-card${copied ? ' is-copied' : ''}${dragging ? ' is-dragging' : ''}${dropTarget ? ' is-drop-target' : ''}`} data-account-id={account.id} aria-label={label} tabIndex={preview ? -1 : 0} aria-keyshortcuts="Enter Space" onClick={(event) => {
    if (preview || dragging || (event.target as HTMLElement).closest('button, input, a, [data-no-copy]') || window.getSelection()?.toString()) return;
    onCopy();
  }} onKeyDown={(event) => {
    if (event.target !== event.currentTarget || preview || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault(); onCopy();
  }}>
    <header className="account-card-header">{onDragStart && <button className="icon-button drag-handle" aria-label={`ลากเรียงบัญชี ${label}`} aria-describedby="reorder-help" title="ลากเพื่อเรียง หรือใช้ปุ่มลูกศร" disabled={preview || moving} onPointerDown={onDragStart} onKeyDown={onReorderKey}><GripVertical size={18} /></button>}<ProviderIcon name={name} /><div className="account-name"><h3 title={name}>{name}</h3><p title={account.account}>{account.account}</p></div>
      <div className="account-options" ref={menu}><button ref={menuButton} className="icon-button account-more" aria-label={`ตัวเลือกบัญชี ${label}`} aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpen((old) => !old)}><MoreHorizontal size={19} /></button>
        {menuOpen && <div className="account-options-panel" id={menuId}>{onMoveTop && <button disabled={preview || moving} onClick={() => { setMenuOpen(false); onMoveTop(); }}><ArrowUpToLine size={16} />ย้ายขึ้นบนสุด</button>}<button disabled={preview} aria-label={`แสดง QR สำหรับแอปอื่น ${label}`} onClick={() => { setMenuOpen(false); onExport(); }}><QrCode size={16} />แสดง QR สำหรับแอปอื่น</button><button className="account-remove" disabled={preview} aria-label={`ลบบัญชี ${label}`} onClick={() => { setMenuOpen(false); onDelete(); }}><Trash2 size={16} />ลบบัญชี</button></div>}
      </div>
    </header>
    <div className="code-group"><span className="otp-code" aria-label={hidden ? 'รหัสถูกซ่อน' : `รหัส ${account.code}`}>{code}</span><button className="icon-button code-visibility" aria-label={`${hidden ? 'แสดง' : 'ซ่อน'}รหัส ${label}`} aria-pressed={hidden} onClick={() => setHidden((old) => !old)}>{hidden ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
    <footer className="account-card-footer"><span className={`countdown ${account.remaining <= 5 ? 'expiring' : ''}`} style={{ '--progress': `${account.remaining / account.period * 100}%` } as CSSProperties} title={`รหัสเปลี่ยนใน ${account.remaining} วินาที`} aria-label={`เหลือ ${account.remaining} วินาที`}><i aria-hidden="true" /><span>{account.remaining} วินาที</span></span>
      <button className={`copy-button ${copied ? 'copied' : ''}`} disabled={preview} aria-label={`คัดลอกรหัส ${label}`} onClick={onCopy}>{copied ? <Check size={15} /> : <Copy size={15} />}<span>{copied ? 'คัดลอกแล้ว' : 'คัดลอก'}</span></button>
    </footer>
  </article>;
}
