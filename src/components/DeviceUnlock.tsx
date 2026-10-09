import { useState, type FormEvent } from 'react';
import { api, safeError } from '../api';
import type { DeviceUnlockStatus } from '../types';
import { Modal } from './Modal';

export function DeviceUnlock({ status, onChanged, onClose }: {
  status: DeviceUnlockStatus; onChanged: (status: DeviceUnlockStatus) => void; onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function enable(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const value = password; setPassword('');
    try { onChanged(await api.enableDevice(value)); }
    catch (error) { setError(safeError(error)); }
    finally { setBusy(false); }
  }
  async function disable() {
    setBusy(true); setError('');
    try { onChanged(await api.disableDevice()); }
    catch (error) { setError(safeError(error)); }
    finally { setBusy(false); }
  }
  return <Modal title={`ปลดล็อกด้วย ${status.label}`} busy={busy} onClose={onClose}>
    <p className="muted">เปิดใช้เฉพาะเครื่องนี้ คุณยังใช้รหัสผ่านหลักได้เสมอ และต้องเก็บรหัสผ่านไว้สำหรับไฟล์สำรองหรือย้ายเครื่อง</p>
    {status.enabled ? <><p>เปิดใช้ {status.label} สำหรับคลังนี้แล้ว</p>{!status.available && <p className="muted">อุปกรณ์ยังไม่พร้อมใช้งาน ใช้รหัสผ่านหลักเพื่อปลดล็อกได้ตามเดิม</p>}{error && <p className="error" role="alert">{error}</p>}<footer className="modal-actions"><button className="secondary" disabled={busy} onClick={onClose}>ปิด</button><button className="primary" disabled={busy} onClick={() => void disable()}>{busy ? 'กำลังปิดใช้งาน…' : `ปิดใช้ ${status.label}`}</button></footer></>
      : status.available ? <form onSubmit={enable}><label>ยืนยันรหัสผ่านหลัก<input type="password" autoComplete="current-password" required maxLength={1024} disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label><p className="field-help">จากนั้นยืนยันกับ {status.label} เพื่อเปิดใช้</p>{error && <p className="error" role="alert">{error}</p>}<footer className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={onClose}>ยกเลิก</button><button className="primary" disabled={busy}>{busy ? 'กำลังยืนยัน…' : `เปิดใช้ ${status.label}`}</button></footer></form>
      : <><p>เครื่องนี้ยังไม่รองรับหรือยังไม่ได้ตั้งค่า {status.label} ใช้รหัสผ่านหลักได้ตามเดิม</p><footer className="modal-actions"><button className="secondary" onClick={onClose}>ปิด</button></footer></>}
  </Modal>;
}
