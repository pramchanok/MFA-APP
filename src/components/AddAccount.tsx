import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Camera, ImagePlus, KeyRound, ScanLine } from 'lucide-react';
import { readQr } from '../qr';
import { emptyAccount, type AccountCode, type AccountInput, type GoogleExportPreview } from '../types';
import { api, desktop, safeError } from '../api';
import { Modal } from './Modal';
import { CameraScanner } from './CameraScanner';
import './import.css';

const reasons: Record<string, string> = { duplicate: 'มีบัญชีนี้แล้ว ข้ามเพื่อไม่สร้างซ้ำ', hotp: 'รหัสแบบ HOTP ยังไม่รองรับ', algorithm: 'อัลกอริทึมนี้ยังไม่รองรับ', digits: 'จำนวนหลักนี้ยังไม่รองรับ', type: 'รูปแบบนี้ยังไม่รองรับ' };
type Kind = 'totp' | 'google';

export function AddAccount({ onClose, onSaved }: { onClose: () => void; onSaved: (accounts: AccountCode[], importedCount?: number) => void; initialMode?: 'manual' | 'google' }) {
  const [manual, setManual] = useState(false);
  const [camera, setCamera] = useState(false);
  const [input, setInput] = useState<AccountInput>({ ...emptyAccount });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<GoogleExportPreview | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const uris = useRef<string[]>([]);
  const kind = useRef<Kind | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const working = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; uris.current = []; }; }, []);
  const close = () => { alive.current = false; uris.current = []; setCamera(false); setInput({ ...emptyAccount }); setDraft(''); onClose(); };
  const update = <K extends keyof AccountInput>(key: K, value: AccountInput[K]) => setInput((old) => ({ ...old, [key]: value }));
  const setWorking = (value: boolean) => { working.current = value; setBusy(value); };

  async function inspect(values?: string[], files?: File[]) {
    if (!desktop || working.current) return;
    if (!files?.length && !values?.length && !draft.trim()) return;
    setWorking(true); setError(''); setCamera(false);
    let added: string[] = [];
    try {
      if (uris.current.length + (files?.length ?? values?.length ?? 1) > 100) throw new Error('เพิ่มได้ไม่เกิน 100 QR ต่อครั้ง');
      if (files) {
        for (const file of files) { added.push(await readQr(file)); if (!alive.current) return; }
      } else { added = (values ?? [draft]).map((value) => value.trim()); }
      const kinds = added.map((uri): Kind => {
        if (uri.startsWith('otpauth-migration://offline?')) return 'google';
        if (uri.startsWith('otpauth://totp/')) return 'totp';
        throw new Error('QR นี้ไม่ใช่รหัส TOTP ที่รองรับ ใช้ QR ตั้งค่าจากบริการ หรือ QR ส่งออกจาก Google Authenticator');
      });
      if (kinds.some((value) => value !== (kind.current ?? kinds[0]))) throw new Error('กรุณาบันทึกหรือเริ่มชุดใหม่ก่อนสลับระหว่าง QR ตั้งค่าของบริการกับชุดส่งออกจาก Google');
      const nextKind = kind.current ?? kinds[0];
      const combined = [...uris.current, ...added];
      const result = await (nextKind === 'google' ? api.previewGoogle(combined) : api.previewAccounts(combined));
      if (!alive.current) return;
      const previousCount = preview?.entries.length ?? 0;
      uris.current = combined; kind.current = nextKind;
      setSelected((old) => result.entries.filter((entry) => !entry.reason && (entry.index >= previousCount || old.includes(entry.index))).map((entry) => entry.index));
      setPreview(result);
    } catch (cause) { if (alive.current) setError(safeError(cause)); }
    finally { added = []; if (alive.current) { setDraft(''); setWorking(false); if (fileInput.current) fileInput.current.value = ''; } }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!desktop || working.current || (!manual && (!preview?.complete || !selected.length))) return;
    setError('');
    if (manual && !/^[A-Z2-7]+=*$/i.test(input.secret.replace(/\s/g, ''))) { setError('คีย์ลับต้องเป็น Base32: ตัวอักษร A–Z และตัวเลข 2–7'); return; }
    setWorking(true);
    try {
      const result = manual ? await api.add({ ...input, uri: '' }) : kind.current === 'google' ? await api.importGoogle(uris.current, selected) : await api.importAccounts(uris.current, selected);
      if (alive.current) { uris.current = []; setInput({ ...emptyAccount }); setDraft(''); onSaved(result, manual ? undefined : selected.length); }
    } catch (cause) { if (alive.current) setError(safeError(cause)); }
    finally { if (alive.current) setWorking(false); }
  }

  function reset() { uris.current = []; kind.current = null; setPreview(null); setSelected([]); setDraft(''); setError(''); }
  function changeManual(next: boolean) { setCamera(false); setInput({ ...emptyAccount }); setDraft(''); setError(''); setManual(next); }

  return <Modal title="เพิ่ม / นำเข้าบัญชี" onClose={close} busy={busy}>
    <p className="muted import-intro">ใช้ QR ตั้งค่า 2FA ของบริการต่าง ๆ หรือชุดส่งออกจาก Google Authenticator แอปตรวจรูปแบบให้เอง</p>
    {!desktop && <p className="notice">หน้าตัวอย่างเท่านั้น กรุณาเพิ่มบัญชีจริงในแอป Desktop</p>}
    <div className="import-source-actions">
      <button type="button" className="import-source" disabled={busy || !desktop} onClick={() => { changeManual(false); setCamera(true); }}><Camera size={23} /><span><strong>สแกนด้วยกล้อง</strong><small>ส่อง QR บนมือถือได้เลย</small></span></button>
      <button type="button" className="import-source" disabled={busy || !desktop} onClick={() => { changeManual(false); fileInput.current?.click(); }}><ImagePlus size={23} /><span><strong>เลือกรูป QR</strong><small>เลือกหลายรูปได้</small></span></button>
    </div>
    <input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp" className="visually-hidden" tabIndex={-1} aria-label="รูป QR สำหรับเพิ่มบัญชี" disabled={busy || !desktop} onChange={(e) => { if (e.target.files?.length) void inspect(undefined, Array.from(e.target.files)); }} />
    {camera && <CameraScanner onRead={(uri) => { setCamera(false); void inspect([uri]); }} onClose={() => setCamera(false)} />}
    <div className="import-entry-heading"><strong>{manual ? 'กรอกคีย์ลับ' : 'หรือวาง URI'}</strong><button type="button" className="text-button" disabled={busy || !desktop} onClick={() => changeManual(!manual)}>{manual ? <><ScanLine size={15} />วาง URI แทน</> : <><KeyRound size={15} />กรอกคีย์ลับแทน</>}</button></div>
    {manual ? <form onSubmit={save}>
      <fieldset disabled={busy || !desktop}>
        <div className="form-grid manual-identities"><label>บริการ<input value={input.issuer} maxLength={100} onChange={(e) => update('issuer', e.target.value)} placeholder="เช่น Google, Microsoft, GitHub" autoComplete="off" /></label><label>ชื่อบัญชี<input required value={input.account} maxLength={200} onChange={(e) => update('account', e.target.value)} placeholder="name@example.com" autoComplete="off" /></label></div>
        <label>คีย์ลับ<input required className="secret-input" value={input.secret} onChange={(e) => update('secret', e.target.value)} placeholder="คีย์ Base32 จากบริการ" autoComplete="off" spellCheck={false} type="password" maxLength={1024} /></label>
        <details className="advanced"><summary>ตั้งค่ารหัสเพิ่มเติม</summary><div className="form-grid">
          <label>อัลกอริทึม<select value={input.algorithm} onChange={(e) => update('algorithm', e.target.value as AccountInput['algorithm'])}><option>SHA1</option><option>SHA256</option><option>SHA512</option></select></label>
          <label>จำนวนหลัก<select value={input.digits} onChange={(e) => update('digits', Number(e.target.value))}><option value={6}>6 หลัก</option><option value={8}>8 หลัก</option></select></label>
          <label>รอบเวลา (วินาที)<input type="number" value={input.period} min={15} max={120} onChange={(e) => update('period', Number(e.target.value))} /></label>
        </div></details>
      </fieldset>
      {preview && <p className="field-help">รายการ QR ที่ตรวจไว้ยังอยู่ กด “วาง URI แทน” เพื่อกลับไปตรวจและบันทึก</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <footer className="modal-actions"><button className="secondary" type="button" onClick={close} disabled={busy}>ยกเลิก</button><button className="primary" disabled={busy || !desktop}>{busy ? 'กำลังบันทึก…' : 'เพิ่มบัญชี'}</button></footer>
    </form> : <>
      <form className="import-uri-form" onSubmit={(e) => { e.preventDefault(); void inspect(); }}><label className="visually-hidden" htmlFor="setup-uri">URI ตั้งค่า 2FA หรือส่งออกบัญชี</label><input id="setup-uri" type="password" value={draft} disabled={busy || !desktop} onChange={(e) => setDraft(e.target.value)} placeholder="otpauth:// หรือ otpauth-migration://" maxLength={32768} autoComplete="off" spellCheck={false} /><button className="secondary" disabled={!draft.trim() || busy || !desktop}>อ่านรายการบัญชี</button></form>
      {busy && <p className="field-help" role="status">กำลังประมวลผลในเครื่อง…</p>}
      {preview && <section className="migration-preview" aria-label="ตรวจบัญชีก่อนบันทึก">
        <div className="migration-summary"><strong>{kind.current === 'google' ? `อ่านแล้ว ${preview.parts} / ${preview.expected} QR` : `พบ ${preview.entries.length} บัญชี`}</strong><button className="text-button" type="button" onClick={reset} disabled={busy}>เริ่มชุดใหม่</button></div>
        {!preview.complete && <p className="notice" role="status">กรุณาสแกนหรือเพิ่ม QR ที่เหลือให้ครบชุดก่อนนำเข้า</p>}
        <div className="migration-list">{preview.entries.map((entry) => <label key={entry.index} className="migration-entry"><input type="checkbox" checked={selected.includes(entry.index)} disabled={busy || !!entry.reason} onChange={(e) => setSelected((old) => e.target.checked ? [...old, entry.index] : old.filter((index) => index !== entry.index))} /><span><strong>{entry.issuer || 'ไม่ระบุบริการ'}</strong><span>{entry.account}</span><small>{entry.reason ? reasons[entry.reason] ?? 'ไม่รองรับรายการนี้' : `${entry.algorithm} · ${entry.digits} หลัก`}</small></span></label>)}</div>
        <p className="field-help">เลือกนำเข้า {selected.length} บัญชี โปรดตรวจรายการก่อนยืนยันบันทึก</p>
      </section>}
      {error && <p role="alert" className="error">{error}</p>}
      <form onSubmit={save}><footer className="modal-actions"><button className="secondary" type="button" onClick={close} disabled={busy}>ยกเลิก</button><button className="primary" disabled={!desktop || busy || !preview?.complete || !selected.length}>{busy ? 'กำลังบันทึก…' : `นำเข้า ${selected.length} บัญชี`}</button></footer></form>
    </>}
    <details className="advanced import-help"><summary>QR แบบไหนที่ใช้ได้?</summary><p>รองรับ QR ตั้งค่า TOTP จาก Google, Microsoft, GitHub และบริการอื่นที่ใช้มาตรฐานเดียวกัน รวมถึงชุดส่งออกจาก Google Authenticator หากมีหลาย QR ให้เพิ่มให้ครบชุด</p><p>Microsoft Authenticator ต้องใช้ QR ตั้งค่า TOTP จากเว็บไซต์ของบริการนั้น ไม่รองรับ QR แจ้งเตือนอนุมัติหรือจับคู่ตัวเลข บัญชีใหม่ในแอป Authenticator ต้องนำเข้ามาเพิ่มอีกครั้ง</p><p>รูป PNG, JPG หรือ WebP ไม่เกิน 8 MB ต่อรูป การอ่าน QR และกล้องทำในเครื่อง</p></details>
  </Modal>;
}
