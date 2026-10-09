import { Check, Cloud } from 'lucide-react';
import type { SyncStatus } from '../types';
import { Modal } from './Modal';

export function GoogleImportResult({ count, status, working, syncError, onSync, onClose }: {
  count: number; status: SyncStatus | null; working: boolean; syncError: string;
  onSync: () => void; onClose: () => void;
}) {
  return <Modal title={`นำเข้าแล้ว ${count} บัญชี`} onClose={onClose}>
    <div className="sync-intro"><Check size={24} /><p>บัญชีที่เลือกอยู่ในแอป MFA แล้ว เปิดดูและคัดลอกรหัสได้ทันที แม้ไม่มีอินเทอร์เน็ต</p></div>
    <section className="import-next-step" aria-label="ซิงค์หลังนำเข้า">
      <h3><Cloud size={20} />ใช้บัญชีชุดนี้บนเครื่องอื่น</h3>
      {!status ? <p className={syncError ? 'error' : 'field-help'} role="status">{syncError ? `ตรวจการตั้งค่าซิงค์ไม่สำเร็จ บัญชีที่นำเข้ายังอยู่ในเครื่อง: ${syncError}` : 'กำลังตรวจการตั้งค่าซิงค์…'}</p> : status.configured ? <>
        <p>แอปจะส่งบัญชีที่นำเข้าไปยังคลังซิงค์ที่เชื่อมต่อไว้ อุปกรณ์ที่จับคู่แล้วจะรับข้อมูลขณะเปิดและปลดล็อกแอป MFA</p>
        <p className={syncError ? 'error' : 'notice'} role="status">{syncError ? `ยังซิงค์ไม่สำเร็จ บัญชีในเครื่องยังใช้งานได้: ${syncError}` : working ? 'กำลังซิงค์บัญชี…' : status.pending ? `มี ${status.pending} รายการรอส่ง เมื่อเชื่อมต่อได้แอปจะซิงค์อีกครั้ง` : status.lastSync ? 'ไม่มีรายการรอส่ง · ซิงค์กับเซิร์ฟเวอร์แล้ว' : 'บัญชีพร้อมซิงค์ รอการเชื่อมต่อครั้งแรก'}</p>
      </> : <p>ตั้งค่าคลังซิงค์ครั้งแรก แล้วใช้ QR จับคู่กับแอป MFA บนเครื่องอื่น บัญชีที่นำเข้าและบัญชีที่เพิ่มผ่านแอปนี้จะซิงค์ถึงกัน</p>}
      <p className="field-help">บัญชีใหม่ใน Google หรือ Microsoft Authenticator ต้องนำเข้ามาเพิ่ม แอป MFA ไม่ดึงบัญชีจากสองแอปนี้โดยอัตโนมัติ</p>
    </section>
    <footer className="modal-actions import-result-actions"><button className="secondary" onClick={onClose}>ดูรหัสที่นำเข้า</button><button className="primary" disabled={!status} onClick={onSync}>{status?.configured ? 'จัดการซิงค์ / จับคู่เครื่องอื่น' : 'ตั้งค่าซิงค์อุปกรณ์'}</button></footer>
  </Modal>;
}
