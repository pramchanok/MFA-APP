import { useEffect, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { Cloud, QrCode, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, desktop, safeError } from '../api';
import { readQr } from '../qr';
import type { AccountCode, PairingInfo, SyncStatus } from '../types';
import { Modal } from './Modal';

export function Sync({ status, working, syncError, refresh, onChanged, onClose, mobile = false, initialMode = 'pair' }: {
  status: SyncStatus | null; working: boolean; syncError: string;
  refresh: () => Promise<void>; onChanged: (accounts?: AccountCode[]) => void; onClose: () => void; mobile?: boolean; initialMode?: 'pair' | 'create';
}) {
  const [mode, setMode] = useState<'pair' | 'create'>(initialMode);
  const [server, setServer] = useState('https://mfa-sync.pramchanok.workers.dev');
  const [registration, setRegistration] = useState('');
  const [uri, setUri] = useState('');
  const [qr, setQr] = useState('');
  const [pairing, setPairing] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const alive = useRef(true);
  const revealEpoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { if (qr) panel.current?.scrollIntoView?.({ block: 'start' }); }, [qr]);
  let destination = '';
  try {
    const encoded = new URL(uri).searchParams.get('data') ?? '';
    if (encoded.length < 8192) {
      const bundle: unknown = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
      if (bundle && typeof bundle === 'object' && 'server' in bundle && typeof bundle.server === 'string') destination = bundle.server.slice(0, 2048);
    }
  } catch { /* Native validation remains authoritative when submitting. */ }
  function hide() {
    revealEpoch.current += 1;
    setQr(''); setPairing('');
    if (timer.current) clearTimeout(timer.current);
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; revealEpoch.current += 1; if (timer.current) clearTimeout(timer.current); };
  }, []);
  async function reveal(info: PairingInfo) {
    hide();
    const token = revealEpoch.current;
    // The pairing capability grants full vault access. Never save it to disk,
    // browser storage, telemetry or a clipboard. Expire the visible copy.
    const data = await QRCode.toDataURL(info.uri, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
    if (!alive.current || token !== revealEpoch.current) return;
    setPairing(info.uri); setQr(data);
    timer.current = setTimeout(hide, 60_000);
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(''); setBusy(true); hide();
    try {
      if (mode === 'pair') {
        const accounts = await api.syncPair(uri.trim());
        if (!alive.current) return;
        setUri(''); onChanged(accounts);
      } else {
        const result = await api.syncCreate(server.trim(), registration);
        if (!alive.current) return;
        setRegistration(''); onChanged(); await reveal(result);
      }
    } catch (e) { if (alive.current) { setError(safeError(e)); setRegistration(''); setUri(''); onChanged(); } }
    finally { if (alive.current) setBusy(false); }
  }
  async function load(file?: File) {
    if (!file) return;
    setError(''); setBusy(true);
    try {
      const value = await readQr(file);
      if (!value.startsWith('mfa-sync://pair?')) throw new Error('ใช้ QR จับคู่อุปกรณ์จากแอป MFA เท่านั้น');
      if (alive.current) setUri(value);
    } catch (e) { if (alive.current) setError(safeError(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function showPairing() {
    setBusy(true); setError('');
    try { await reveal(await api.syncPairing()); }
    catch (e) { if (alive.current) setError(safeError(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError(''); hide();
    try { await api.syncDisconnect(); if (alive.current) { setConfirm(false); onChanged(); } }
    catch (e) { if (alive.current) setError(safeError(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <Modal title="ซิงค์อุปกรณ์" busy={busy} onClose={onClose}>
    <div className="sync-intro"><ShieldCheck size={24} /><p>ซิงค์คีย์ 2FA แบบเข้ารหัสระหว่างแอป MFA บนมือถือและคอมของคุณ เซิร์ฟเวอร์อ่านคีย์ลับไม่ได้</p></div>
    <p className="field-help">เพิ่มบัญชีใหม่ผ่านแอปนี้เพื่อให้ซิงค์ถึงกัน แอปไม่ได้ดึงบัญชีที่เพิ่มใน Google Authenticator หรือ Microsoft Authenticator โดยอัตโนมัติ</p>
    {!desktop ? <p className="notice">จับคู่อุปกรณ์ได้ในแอปที่ติดตั้งเท่านั้น หน้านี้เป็นตัวอย่าง</p> : status?.configured ? <>
      <div className="sync-summary"><Cloud size={21} /><div><strong>เชื่อมต่อคลังซิงค์แล้ว</strong><span>{status.server}</span><small>{status.pending ? `รอส่ง ${status.pending} รายการ` : 'ไม่มีรายการรอส่ง'} · {status.lastSync ? `ซิงค์ล่าสุด ${new Date(status.lastSync * 1000).toLocaleString('th-TH')}` : 'ยังไม่เคยซิงค์สำเร็จ'}</small></div></div>
      <p className="field-help">ส่งเมื่อเพิ่มหรือลบบัญชี และตรวจข้อมูลจากเครื่องอื่นทุก 1–2 นาทีขณะเปิดแอปและปลดล็อก กดซิงค์ตอนนี้เพื่อรับทันที เมื่อออฟไลน์ยังดูรหัสได้</p>
      {syncError && <p className="error" role="status">ซิงค์ยังไม่สำเร็จ ข้อมูลในเครื่องยังใช้งานได้: {syncError}</p>}
      <div className="sync-actions"><button className="secondary" disabled={busy || working} onClick={() => void refresh()}><RefreshCw size={16} />{working ? 'กำลังซิงค์…' : 'ซิงค์ตอนนี้'}</button><button className="secondary" disabled={busy} onClick={() => void showPairing()}><QrCode size={16} />แสดง QR จับคู่อุปกรณ์</button></div>
      <details className="advanced"><summary>ยกเลิกการซิงค์เครื่องนี้</summary><p>บัญชีในเครื่องยังอยู่ อุปกรณ์อื่นที่จับคู่แล้วยังเข้าถึงคลังเดิมได้ รายการที่รอส่งจะไม่ถูกส่งต่อ</p><label className="checkbox-label"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /><span>ยืนยันหยุดซิงค์เฉพาะเครื่องนี้</span></label><button className="danger" disabled={busy || !confirm} onClick={() => void disconnect()}>หยุดซิงค์เครื่องนี้</button></details>
    </> : <>
      <div className="segmented"><button aria-pressed={mode === 'pair'} disabled={busy} onClick={() => { setMode('pair'); setError(''); }}>จับคู่กับเครื่องเดิม</button><button aria-pressed={mode === 'create'} disabled={busy} onClick={() => { setMode('create'); setError(''); }}>ตั้งค่าคลังซิงค์ใหม่</button></div>
      <form onSubmit={submit}>
        {mode === 'pair' ? <><p className="field-help">เปิดเมนูซิงค์ในเครื่องที่ตั้งค่าแล้ว เลือกแสดง QR จับคู่อุปกรณ์ บัญชีที่มีอยู่ในเครื่องนี้จะรวมเข้าในคลังซิงค์ด้วย</p><label className="upload-area"><QrCode size={26} /><strong>ถ่ายหรือเลือกรูป QR จับคู่</strong><input type="file" accept="image/*" capture="environment" disabled={busy} onChange={(e) => { void load(e.target.files?.[0]); e.target.value = ''; }} /></label>{mobile && <p className="field-help">หากกลับจากกล้องแล้วแอปล็อก ให้ปลดล็อกและวางรหัสจับคู่จากเครื่องเดิมแทน</p>}<label>หรือวางรหัสจับคู่<input type="password" autoComplete="off" spellCheck={false} maxLength={8192} required value={uri} onChange={(e) => setUri(e.target.value)} disabled={busy} /></label>{destination && <p className="notice">ปลายทางจากรหัสจับคู่: <strong className="sync-destination">{destination}</strong></p>}</> : <><p className="field-help">สร้างคลังจากเครื่องนี้ครั้งเดียว บัญชีทั้งหมดในเครื่องจะเข้าคิวซิงค์ จากนั้นจับคู่เครื่องอื่นด้วย QR ใช้บริการ Cloudflare ที่กรอกไว้ หรือเปลี่ยนเป็นเซิร์ฟเวอร์ของคุณเองได้</p><label>ที่อยู่เซิร์ฟเวอร์<input type="url" placeholder="https://sync.example.com" autoComplete="off" required value={server} onChange={(e) => setServer(e.target.value)} disabled={busy} /></label><p className="field-help">โทเคนสร้างคลังรับจากผู้ดูแลบริการซิงค์ ใช้เฉพาะการสร้างคลังครั้งแรก เครื่องถัดไปใช้ QR จับคู่ได้เลย</p><label>โทเคนสร้างคลัง<input type="password" autoComplete="off" required value={registration} onChange={(e) => setRegistration(e.target.value)} disabled={busy} /></label></>}
        <footer className="modal-actions"><button className="primary" disabled={busy || !status}>{busy ? 'กำลังเชื่อมต่อ…' : mode === 'pair' ? 'จับคู่และรวมบัญชี' : 'สร้างคลังซิงค์'}</button></footer>
      </form>
    </>}
    {qr && <div className="pairing-panel" ref={panel}><h3>จับคู่เครื่องที่คุณไว้ใจ</h3><p className="field-help">ใครได้ QR หรือรหัสนี้จะเข้าถึงบัญชี 2FA ทั้งคลังได้ จะแสดงเป็นเวลา 60 วินาที</p><img src={qr} width={320} height={320} alt="QR จับคู่อุปกรณ์ MFA" /><label>รหัสจับคู่สำหรับอีกเครื่อง<input readOnly type="password" autoComplete="off" value={pairing} onFocus={(e) => e.target.select()} /></label><button className="secondary" onClick={hide}>ซ่อน QR และรหัสจับคู่</button></div>}
    {error && <p className="error" role="alert">{error}</p>}
  </Modal>;
}
