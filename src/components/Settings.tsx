import { Monitor, Moon, RefreshCw, ShieldCheck, Sun } from 'lucide-react';
import type { AppInfo, DeviceUnlockStatus } from '../types';
import type { Appearance } from '../useAppearance';
import { Modal } from './Modal';

export function Settings({ appearance, onAppearance, info, device, native, updateHint, onDevice, onUpdates, onClose }: {
  appearance: Appearance; onAppearance: (value: Appearance) => void; info: AppInfo; device: DeviceUnlockStatus;
  native: boolean; updateHint: string; onDevice: () => void; onUpdates: () => void; onClose: () => void;
}) {
  return <Modal title="ตั้งค่า" onClose={onClose}>
    <section className="settings-section"><h3>หน้าตาแอป</h3><div className="appearance-options" role="group" aria-label="หน้าตาแอป">{([{ value: 'light', label: 'สว่าง', Icon: Sun }, { value: 'dark', label: 'มืด', Icon: Moon }, { value: 'system', label: 'ตามระบบ', Icon: Monitor }] as const).map(({ value, label, Icon }) => <button key={value} aria-pressed={appearance === value} onClick={() => onAppearance(value)}><Icon size={21} />{label}</button>)}</div></section>
    <section className="settings-section"><h3>ความปลอดภัย</h3><p className="field-help">ล็อกอัตโนมัติเมื่อซ่อนแอป หรือไม่มีการใช้งาน 5 นาที</p>{native && !info.mobile && <button className="settings-action" aria-label={device.label === 'ปลดล็อกด้วยอุปกรณ์' ? device.label : `ตั้งค่า ${device.label}`} onClick={onDevice}><ShieldCheck size={19} /><span>{device.label === 'ปลดล็อกด้วยอุปกรณ์' ? device.label : `ตั้งค่า ${device.label}`}<small>{device.enabled ? 'เปิดใช้งานแล้ว' : 'ใช้รหัสผ่านหลัก หรือเปิดการปลดล็อกด้วยอุปกรณ์'}</small></span></button>}</section>
    <section className="settings-section settings-about"><div><strong>MFA Desktop</strong><span>เวอร์ชัน {info.version}</span></div>{!info.mobile && <button className="secondary" onClick={onUpdates}><RefreshCw size={16} />อัปเดตแอป</button>}{updateHint && <p className="field-help">{updateHint}</p>}</section>
  </Modal>;
}
