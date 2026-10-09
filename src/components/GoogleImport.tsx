import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ImagePlus } from 'lucide-react';
import { api, desktop, safeError } from '../api';
import { readQr } from '../qr';
import type { AccountCode, GoogleExportPreview } from '../types';

const reasons: Record<string, string> = {
  duplicate: 'มีชื่อบริการและบัญชีนี้แล้ว — ข้ามเพื่อไม่สร้างซ้ำ',
  hotp: 'เป็นรหัสแบบ HOTP ซึ่งยังไม่รองรับ',
  algorithm: 'อัลกอริทึมนี้ยังไม่รองรับ',
  digits: 'จำนวนหลักนี้ยังไม่รองรับ',
  type: 'รูปแบบรหัสนี้ยังไม่รองรับ',
};

export function GoogleImport({ onClose, onSaved, onBusy }: {
  onClose: () => void; onSaved: (accounts: AccountCode[], importedCount: number) => void; onBusy: (busy: boolean) => void;
}) {
  const [preview, setPreview] = useState<GoogleExportPreview | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const uris = useRef<string[]>([]);
  const alive = useRef(true);
  const working = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; uris.current = []; };
  }, []);
  const setWorking = (value: boolean) => { working.current = value; setBusy(value); onBusy(value); };

  async function inspect(files?: FileList) {
    if (!desktop || working.current) return;
    if ((!files || !files.length) && !draft.trim()) return;
    setWorking(true); setError('');
    let added: string[] = [];
    try {
      if (uris.current.length + (files?.length ?? 1) > 100) throw new Error('นำเข้าได้ไม่เกิน 100 QR ต่อชุด');
      if (files) {
        for (const file of Array.from(files)) {
          const uri = await readQr(file);
          if (!alive.current) return;
          added.push(uri);
        }
      } else { added = [draft.trim()]; }
      if (added.some((uri) => !uri.startsWith('otpauth-migration://offline?'))) {
        throw new Error('ใช้ QR จาก Google Authenticator → โอนบัญชี → ส่งออกบัญชี สำหรับ QR ตั้งค่าจากเว็บไซต์ให้เลือกแท็บ QR Code / URI');
      }
      const combined = [...uris.current, ...added];
      const result = await api.previewGoogle(combined);
      if (!alive.current) return;
      const previousCount = preview?.entries.length ?? 0;
      uris.current = combined;
      setSelected((old) => result.entries.filter((entry) => !entry.reason && (entry.index >= previousCount || old.includes(entry.index))).map((entry) => entry.index));
      setPreview(result);
    } catch (e) { if (alive.current) setError(safeError(e)); }
    finally {
      added = [];
      if (alive.current) { setDraft(''); setWorking(false); if (fileInput.current) fileInput.current.value = ''; }
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!desktop || working.current || !preview?.complete || !selected.length) return;
    setWorking(true); setError('');
    try {
      const result = await api.importGoogle(uris.current, selected);
      if (alive.current) { uris.current = []; setDraft(''); onSaved(result, selected.length); }
    } catch (e) { if (alive.current) setError(safeError(e)); }
    finally { if (alive.current) setWorking(false); }
  }

  function reset() { uris.current = []; setPreview(null); setSelected([]); setDraft(''); setError(''); }

  return <div className="google-import">
    <ol className="import-steps"><li>เปิด Google Authenticator บนมือถือ</li><li>เลือก <strong>โอนบัญชี → ส่งออกบัญชี</strong> แล้วเลือกบัญชีที่ต้องการ</li><li>นำรูป QR มาเลือกด้านล่าง หากมีหลาย QR ให้เพิ่มให้ครบชุด</li></ol>
    <p className="field-help">นำเข้าบัญชีที่เลือกได้พร้อมกัน ไม่ต้องล็อกอิน Google หลังนำเข้าใช้รหัสได้แบบออฟไลน์ และตั้งค่าซิงค์ระหว่างอุปกรณ์ที่ติดตั้งแอป MFA ได้ การเพิ่มบัญชีใน Google Authenticator ภายหลังต้องส่งออกมานำเข้าอีกครั้ง</p>
    <p className="field-help">หากมือถือไม่อนุญาตให้จับภาพ ใช้กล้องคอมถ่าย QR แล้วเลือกรูปนั้น</p>
    <fieldset disabled={busy || !desktop}>
      <input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp" className="visually-hidden" tabIndex={-1} aria-label="รูป QR ส่งออกจาก Google" onChange={(e) => void inspect(e.target.files ?? undefined)} />
      <button className="upload-area" type="button" onClick={() => fileInput.current?.click()}><ImagePlus size={28} /><strong>{preview ? 'เพิ่มรูป QR ถัดไป' : 'เลือกรูป QR ส่งออกจาก Google'}</strong><span>เลือกหลายรูปได้ · อ่านในเครื่อง · PNG, JPG, WebP ไม่เกิน 8 MB ต่อรูป</span></button>
      <form className="migration-uri" onSubmit={(e) => { e.preventDefault(); void inspect(); }}>
        <label>หรือวาง URI ส่งออก<input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="otpauth-migration://offline?data=…" maxLength={32768} autoComplete="off" spellCheck={false} /></label>
        <button className="secondary" disabled={!draft.trim() || busy || !desktop}>อ่านรายการบัญชี</button>
      </form>
    </fieldset>
    {busy && <p className="field-help" role="status">กำลังประมวลผลในเครื่อง…</p>}
    {preview && <section className="migration-preview" aria-label="บัญชีที่พบใน QR">
      <div className="migration-summary"><strong>อ่านแล้ว {preview.parts} / {preview.expected} QR</strong><button className="text-button" type="button" onClick={reset} disabled={busy}>เริ่มชุดใหม่</button></div>
      {!preview.complete && <p className="notice" role="status">กรุณาเพิ่ม QR ที่เหลือให้ครบชุดก่อนนำเข้า</p>}
      <div className="migration-list">{preview.entries.map((entry) => <label key={entry.index} className="migration-entry">
        <input type="checkbox" checked={selected.includes(entry.index)} disabled={busy || !!entry.reason} onChange={(e) => setSelected((old) => e.target.checked ? [...old, entry.index] : old.filter((index) => index !== entry.index))} />
        <span><strong>{entry.issuer || 'ไม่ระบุบริการ'}</strong><span>{entry.account}</span><small>{entry.reason ? reasons[entry.reason] ?? 'ไม่รองรับรายการนี้' : `${entry.algorithm} · ${entry.digits} หลัก · ทุก 30 วินาที`}</small></span>
      </label>)}</div>
      <p className="field-help">เลือกนำเข้า {selected.length} บัญชี · เพิ่มรวมกับบัญชีเดิม โดยไม่แทนที่หรือลบข้อมูลเดิม</p>
    </section>}
    {error && <p role="alert" className="error">{error}</p>}
    <form onSubmit={save}><footer className="modal-actions"><button className="secondary" type="button" onClick={onClose} disabled={busy}>ยกเลิก</button><button className="primary" disabled={!desktop || busy || !preview?.complete || !selected.length}>{busy ? 'กำลังดำเนินการ…' : `นำเข้า ${selected.length} บัญชี`}</button></footer></form>
  </div>;
}
