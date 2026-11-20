import { useState, type FormEvent } from 'react';
import { Monitor, Moon, RefreshCw, ShieldCheck, Sun } from 'lucide-react';
import { safeError } from '../api';
import type { AppInfo, DeviceUnlockStatus } from '../types';
import type { Appearance } from '../useAppearance';
import { Modal } from './Modal';

export function Settings({ appearance, onAppearance, info, device, native, autoLockMinutes, onAutoLock, updateHint, onDevice, onUpdates, onClose }: {
  appearance: Appearance; onAppearance: (value: Appearance) => void; info: AppInfo; device: DeviceUnlockStatus;
  autoLockMinutes: number; onAutoLock: (minutes: number) => Promise<void>;
  native: boolean; updateHint: string; onDevice: () => void; onUpdates: () => void; onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(autoLockMinutes > 0);
  const [minutes, setMinutes] = useState(String(autoLockMinutes || 5));
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const selectedMinutes = enabled ? Number(minutes) : 0;
  async function saveAutoLock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || selectedMinutes === autoLockMinutes) return;
    if (enabled && (!Number.isInteger(selectedMinutes) || selectedMinutes < 1 || selectedMinutes > 1440)) return;
    setSaving(true);
    setFeedback('');
    setError('');
    try {
      await onAutoLock(selectedMinutes);
      setFeedback('บันทึกการตั้งค่าแล้ว');
    } catch (e) {
      setError(safeError(e));
    } finally {
      setSaving(false);
    }
  }

  return <Modal title="ตั้งค่า" onClose={onClose} busy={saving}>
    <section className="settings-section"><h3>หน้าตาแอป</h3><div className="appearance-options" role="group" aria-label="หน้าตาแอป">{([{ value: 'light', label: 'สว่าง', Icon: Sun }, { value: 'dark', label: 'มืด', Icon: Moon }, { value: 'system', label: 'ตามระบบ', Icon: Monitor }] as const).map(({ value, label, Icon }) => <button key={value} aria-pressed={appearance === value} onClick={() => onAppearance(value)}><Icon size={21} />{label}</button>)}</div></section>
    {native && <section className="settings-section"><h3>ความปลอดภัย</h3>
      <form className="auto-lock-settings" onSubmit={saveAutoLock}>
        <label>ล็อกอัตโนมัติ<select value={enabled ? 'idle' : 'off'} disabled={saving} onChange={(event) => {
          setEnabled(event.target.value === 'idle'); setFeedback(''); setError('');
        }}>
          <option value="idle">เมื่อไม่ได้ใช้งาน</option>
          <option value="off">ไม่ล็อกจนกว่าจะปิดแอป</option>
        </select></label>
        {enabled && <label>เวลาที่ไม่ได้ใช้งาน (นาที)<input type="number" min={1} max={1440} step={1} required value={minutes} disabled={saving} onChange={(event) => {
          setMinutes(event.target.value); setFeedback(''); setError('');
        }} /></label>}
        <p className="field-help">{enabled ? 'โหมดนี้จะล็อกเมื่อซ่อนแอปด้วย' : 'กดปุ่มล็อกแอปเองได้ทุกเมื่อ'}</p>
        <button className="secondary" disabled={saving || selectedMinutes === autoLockMinutes}>{saving ? 'กำลังบันทึก…' : 'บันทึกการล็อกอัตโนมัติ'}</button>
        {feedback && <p className="field-help" role="status">{feedback}</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </form>
      {!info.mobile && <button className="settings-action" disabled={saving} aria-label={device.label === 'ปลดล็อกด้วยอุปกรณ์' ? device.label : `ตั้งค่า ${device.label}`} onClick={onDevice}><ShieldCheck size={19} /><span>{device.label === 'ปลดล็อกด้วยอุปกรณ์' ? device.label : `ตั้งค่า ${device.label}`}<small>{device.label === 'Windows Hello' ? 'ปลดล็อกด้วยใบหน้า ลายนิ้วมือ หรือ PIN ของ Windows' : 'ปลดล็อกด้วยอุปกรณ์'} · {device.available ? device.enabled ? 'เปิดใช้งานแล้ว' : 'ยังไม่เปิดใช้' : 'ยังไม่พร้อมใช้งาน'}</small></span></button>}
    </section>}
    <section className="settings-section settings-about"><div><strong>MFA Desktop</strong><span>เวอร์ชัน {info.version}</span></div>{!info.mobile && <button className="secondary" disabled={saving} onClick={onUpdates}><RefreshCw size={16} />อัปเดตแอป</button>}{updateHint && <p className="field-help">{updateHint}</p>}</section>
  </Modal>;
}
