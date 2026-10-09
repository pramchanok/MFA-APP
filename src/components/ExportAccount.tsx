import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, safeError } from '../api';
import type { AccountCode, AccountQr } from '../types';
import { Modal } from './Modal';

export function ExportAccount({ account, onClose }: { account: AccountCode; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [qr, setQr] = useState<AccountQr | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const alive = useRef(true);
  const epoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);

  useEffect(() => { if (qr) doneButton.current?.focus(); else passwordField.current?.focus(); }, [qr]);

  function hide() {
    epoch.current += 1;
    if (timer.current) clearTimeout(timer.current);
    setQr(null); setPassword(''); setBusy(false);
  }
  useEffect(() => {
    alive.current = true;
    // Also purge a pending response if visibility changes before App locks.
    const hidden = () => { if (document.visibilityState === 'hidden') { hide(); setExpired(true); } };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      alive.current = false; epoch.current += 1;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  async function reveal(e: FormEvent) {
    e.preventDefault();
    const token = ++epoch.current;
    const pending = api.accountQr(account.id, password);
    setPassword(''); setBusy(true); setError(''); setExpired(false);
    try {
      const result = await pending;
      if (!alive.current || token !== epoch.current) return;
      setQr(result);
      timer.current = setTimeout(() => { hide(); setExpired(true); }, 60_000);
    } catch (e) {
      if (alive.current && token === epoch.current) setError(safeError(e));
    } finally { if (alive.current && token === epoch.current) setBusy(false); }
  }

  return <Modal title="แสดง QR สำหรับแอปอื่น" onClose={onClose}>
    <p className="export-account-name"><strong>{account.issuer || account.account}</strong>{account.issuer && <span>{account.account}</span>}</p>
    <p className="muted">QR นี้ให้แอปอื่นสร้างรหัสของบัญชีเดียวกันได้ เก็บเป็นความลับและสแกนด้วยอุปกรณ์ของคุณเท่านั้น</p>
    {qr ? <>
      <div className="account-export-qr"><img src={qr.image} alt="QR สำหรับเพิ่มบัญชีในแอป Authenticator" draggable={false} onContextMenu={(e) => e.preventDefault()} /></div>
      <p className="field-help" role="status">QR จะซ่อนอัตโนมัติภายใน 60 วินาที หรือเมื่อแอปล็อก</p>
      {qr.customParameters && <p className="error" role="alert">บัญชีนี้ใช้ค่ารหัสต่างจาก SHA1 / 6 หลัก / 30 วินาที แอปปลายทางบางรุ่นอาจไม่รองรับ กรุณาตรวจว่ารหัสตรงกันก่อนใช้งาน</p>}
      <ol className="export-instructions"><li><strong>Google Authenticator:</strong> กด + → สแกน QR Code</li><li><strong>Microsoft Authenticator:</strong> เพิ่มบัญชี → บัญชีอื่น → สแกน QR</li></ol>
      <p className="field-help">เพิ่มบัญชีแล้วให้ตรวจว่ารหัสตรงกัน การเปลี่ยนแปลงบัญชีภายหลังจะไม่ซิงค์ไปยังแอปอื่น</p>
      <footer className="modal-actions"><button ref={doneButton} className="primary" onClick={onClose}>เสร็จแล้ว / ปิด QR</button></footer>
    </> : <form onSubmit={reveal}>
      {expired && <p className="muted" role="status">ซ่อน QR แล้ว กรุณายืนยันรหัสผ่านอีกครั้งเพื่อแสดงใหม่</p>}
      <label>ยืนยันรหัสผ่านหลัก<input ref={passwordField} type="password" autoComplete="off" required maxLength={1024} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="modal-actions"><button type="button" className="secondary" onClick={onClose}>ยกเลิก</button><button className="primary" disabled={busy || !password}>{busy ? 'กำลังตรวจสอบ…' : 'ยืนยันและแสดง QR'}</button></footer>
    </form>}
  </Modal>;
}
