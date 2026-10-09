import { ArrowDownToLine, ArrowUpFromLine, ShieldCheck } from 'lucide-react';
import { Modal } from './Modal';

export function Backup({ enabled, busy, onExport, onImport, onClose }: {
  enabled: boolean; busy: boolean; onExport: () => void; onImport: () => void; onClose: () => void;
}) {
  return <Modal title="สำรองข้อมูล" onClose={onClose} busy={busy}>
    <p className="muted">เก็บสำเนาคลังบัญชีเป็นไฟล์เข้ารหัส ใช้รหัสผ่านหลัก ณ วันที่สำรองเพื่อเปิดไฟล์นี้</p>
    <div className="backup-actions"><button className="settings-action" aria-label="บันทึกไฟล์สำรอง" disabled={!enabled || busy} onClick={onExport}><ArrowUpFromLine size={23} /><span>บันทึกไฟล์สำรอง<small>สำรองบัญชีทั้งหมดในเครื่องนี้</small></span></button><button className="settings-action" aria-label="นำเข้าข้อมูล" disabled={!enabled || busy} onClick={onImport}><ArrowDownToLine size={23} /><span>นำเข้าข้อมูล<small>กู้คืนจากไฟล์สำรอง โดยตรวจรหัสผ่านและยืนยันก่อนแทนที่</small></span></button></div>
    <p className="field-help"><ShieldCheck size={14} /> ไฟล์สำรองไม่ใช่รูป QR ส่งออกจาก Google</p>
    {!enabled && <p className="notice">ใช้ไฟล์สำรองได้ในแอป Desktop ที่ติดตั้งเท่านั้น</p>}
  </Modal>;
}
