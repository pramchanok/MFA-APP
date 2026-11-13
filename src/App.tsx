import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { check } from '@tauri-apps/plugin-updater';
import { listen } from '@tauri-apps/api/event';
import { Archive, ArrowDownToLine, Check, ChevronRight, Cloud, Fingerprint, FolderKey, GripVertical, KeyRound, LayoutGrid, LockKeyhole, Moon, Plus, Search, Settings2, ShieldCheck, Sun, WifiOff } from 'lucide-react';
import { api, desktop, safeError } from './api';
import type { AccountCode, AppInfo, VaultStatus, DeviceUnlockStatus } from './types';
import { DeviceUnlock } from './components/DeviceUnlock';
import { AccountRow } from './components/AccountRow';
import { ExportAccount } from './components/ExportAccount';
import { AddAccount } from './components/AddAccount';
import { GoogleImportResult } from './components/GoogleImportResult';
import { Modal } from './components/Modal';
import { Updates } from './components/Updates';
import { Sync } from './components/Sync';
import { useSync } from './useSync';
import { useAppearance } from './useAppearance';
import { Settings } from './components/Settings';
import { Backup } from './components/Backup';
import { moveAccount } from './accountOrder';
import { useCardDrag } from './useCardDrag';

const IDLE_MS = 300_000;
type Overlay = 'add' | 'google-done' | 'updates' | 'import' | 'sync' | 'sync-create' | 'device' | 'settings' | 'backup' | null;

export default function App() {
  const appearance = useAppearance();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [device, setDevice] = useState<DeviceUnlockStatus>({ available: false, enabled: false, label: 'ปลดล็อกด้วยอุปกรณ์' });
  const [info, setInfo] = useState<AppInfo>({ version: '0.5.0', updaterConfigured: false });
  const [accounts, setAccounts] = useState<AccountCode[]>([]);
  const [search, setSearch] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [googleImportedCount, setGoogleImportedCount] = useState(0);
  const [deleting, setDeleting] = useState<AccountCode | null>(null);
  const [exporting, setExporting] = useState<AccountCode | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [importPath, setImportPath] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [updateHint, setUpdateHint] = useState('');
  const [startup, setStartup] = useState(0);
  const [moving, setMoving] = useState(false);
  const savingOrder = useRef(false);
  const generation = useRef(0);
  const revision = useRef(0);
  const lastActivity = useRef(Date.now());
  const lastNativeTouch = useRef(0);
  const loadingCodes = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshSyncedAccounts = useCallback(async () => {
    if (savingOrder.current) return;
    const token = generation.current;
    const currentRevision = ++revision.current;
    const codes = await api.codes();
    if (token === generation.current && currentRevision === revision.current) setAccounts(codes);
  }, []);
  const sync = useSync(!!status?.unlocked, refreshSyncedAccounts);

  const notify = useCallback((text: string) => {
    setNotice(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setNotice(''), 5000);
  }, []);

  const clearSensitiveUi = useCallback(() => {
    generation.current += 1;
    setAccounts([]); setPassword(''); setConfirmation(''); setImportPassword('');
    setOverlay(null); setDeleting(null); setExporting(null); setCopied(null); setNotice(''); setSearch('');
    setGoogleImportedCount(0);
    setImportPath(''); setReplaceConfirmed(false); setBusy(false);
    savingOrder.current = false; setMoving(false);
  }, []);

  const lock = useCallback(async (reason = '') => {
    clearSensitiveUi();
    setStatus((old) => ({ exists: old?.exists ?? true, unlocked: false }));
    setError(reason);
    if (desktop) {
      try { await api.lock(); }
      catch { setError('ไม่สามารถยืนยันการล็อกได้ กรุณาปิดและเปิดแอปใหม่'); }
    }
  }, [clearSensitiveUi]);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen('vault-locked', () => {
      clearSensitiveUi();
      setStatus((old) => ({ exists: old?.exists ?? true, unlocked: false }));
      setError('คลังบัญชีถูกล็อก กรุณาปลดล็อกอีกครั้ง');
    }).then((stop) => { if (active) unlisten = stop; else stop(); }).catch(() => { /* Polling also enforces lock state. */ });
    return () => { active = false; unlisten?.(); };
  }, [clearSensitiveUi]);

  useEffect(() => {
    let active = true;
    const token = generation.current;
    setError('');
    Promise.all([api.status(), api.info()]).then(async ([current, app]) => {
      if (!active || token !== generation.current) return;
      setStatus(current); setInfo(app);
      if (current.unlocked) {
        const currentRevision = revision.current;
        const codes = await api.codes();
        if (active && token === generation.current && currentRevision === revision.current) setAccounts(codes);
      }
    }).catch((e) => { if (active && token === generation.current) setError(safeError(e)); });
    return () => { active = false; };
  }, [startup]);

  useEffect(() => {
    if (!desktop || !status) return;
    let active = true;
    // A missing/unavailable platform adapter must never block password login.
    void api.deviceStatus().then((value) => { if (active) setDevice(value); })
      .catch(() => { if (active) setDevice({ available: false, enabled: false, label: 'ปลดล็อกด้วยอุปกรณ์' }); });
    return () => { active = false; };
  }, [status?.unlocked, status?.exists, startup]);

  useEffect(() => {
    if (!status?.unlocked) return;
    lastActivity.current = Date.now();
    const token = generation.current;
    const poll = setInterval(async () => {
      if (loadingCodes.current || savingOrder.current || token !== generation.current) return;
      if (desktop && Date.now() - lastActivity.current >= IDLE_MS) { await lock('ล็อกอัตโนมัติหลังไม่มีการใช้งาน 5 นาที'); return; }
      loadingCodes.current = true;
      const currentRevision = revision.current;
      try { const codes = await api.codes(); if (token === generation.current && currentRevision === revision.current) setAccounts(codes); }
      catch { if (token === generation.current) await lock('คลังบัญชีถูกล็อก กรุณาปลดล็อกอีกครั้ง'); }
      finally { loadingCodes.current = false; }
    }, 1000);
    const activity = () => {
      lastActivity.current = Date.now();
      if (desktop && Date.now() - lastNativeTouch.current > 15_000) {
        lastNativeTouch.current = Date.now();
        void api.touch().catch(() => { if (token === generation.current) void lock('คลังบัญชีถูกล็อก กรุณาปลดล็อกอีกครั้ง'); });
      }
    };
    const hidden = () => { if (desktop && document.visibilityState === 'hidden') void lock(); };
    window.addEventListener('pointerdown', activity); window.addEventListener('pointermove', activity); window.addEventListener('keydown', activity);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      clearInterval(poll); window.removeEventListener('pointerdown', activity); window.removeEventListener('pointermove', activity); window.removeEventListener('keydown', activity);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [status?.unlocked, lock]);

  useEffect(() => {
    if (!desktop || info.mobile || !info.updaterConfigured) return;
    let active = true;
    check().then(async (update) => {
      if (active) setUpdateHint(update ? `มีเวอร์ชัน ${update.version}` : 'เวอร์ชันล่าสุด');
      await update?.close();
    }).catch(() => { if (active) setUpdateHint('ยังตรวจอัปเดตไม่ได้'); });
    return () => { active = false; };
  }, [info.updaterConfigured, info.mobile]);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  async function authenticate(e: FormEvent) {
    e.preventDefault(); setError('');
    if (!status) return;
    if (!status.exists && Array.from(password).length < 6) { setError('ตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร'); return; }
    if (!status.exists && password !== confirmation) { setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน'); return; }
    const token = ++generation.current;
    setBusy(true);
    try {
      const result = status.exists ? await api.unlock(password) : await api.create(password);
      if (token !== generation.current) return;
      setPassword(''); setConfirmation(''); setAccounts(result); lastActivity.current = Date.now();
      setStatus({ exists: true, unlocked: true });
    } catch (e) { if (token === generation.current) { setError(safeError(e)); setPassword(''); setConfirmation(''); } }
    finally { if (token === generation.current) setBusy(false); }
  }

  async function authenticateDevice() {
    const token = ++generation.current;
    setBusy(true); setError(''); setPassword('');
    try {
      const result = await api.unlockDevice();
      if (token !== generation.current) return;
      setAccounts(result); lastActivity.current = Date.now();
      setStatus({ exists: true, unlocked: true });
    } catch (error) {
      if (token === generation.current) setError(safeError(error));
    } finally { if (token === generation.current) setBusy(false); }
  }

  async function copy(account: AccountCode) {
    const token = generation.current;
    try {
      await api.copy(account.id);
      if (token !== generation.current) return;
      setCopied(account.id); notify('คัดลอกรหัสแล้ว คลิปบอร์ดจะถูกล้างใน 30 วินาทีหากยังไม่ได้คัดลอกสิ่งอื่น');
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 2000);
    } catch (e) { if (token === generation.current) setError(safeError(e)); }
  }

  async function remove() {
    if (!deleting) return;
    const token = generation.current; setBusy(true); setError('');
    try { const result = await api.remove(deleting.id); if (token === generation.current) { revision.current += 1; setAccounts(result); setDeleting(null); notify('ลบบัญชีออกจากแอปแล้ว'); void sync.refresh(); } }
    catch (e) { if (token === generation.current) setError(safeError(e)); }
    finally { if (token === generation.current) setBusy(false); }
  }

  async function exportBackup() {
    const token = generation.current; setError('');
    try {
      const path = await save({ title: 'บันทึกไฟล์สำรองที่เข้ารหัส', defaultPath: `mfa-desktop-${new Date().toISOString().slice(0, 10)}.mfa-backup`, filters: [{ name: 'MFA encrypted backup', extensions: ['mfa-backup'] }] });
      if (!path || token !== generation.current) return;
      setBusy(true); await api.exportBackup(path);
      if (token === generation.current) notify('สำรองข้อมูลแล้ว ใช้รหัสผ่านหลักปัจจุบันในการเปิดไฟล์นี้');
    } catch (e) { if (token === generation.current) setError(safeError(e)); }
    finally { if (token === generation.current) setBusy(false); }
  }

  async function chooseImport() {
    const token = generation.current; setError('');
    try {
      const path = await open({ title: 'เลือกไฟล์สำรองที่เข้ารหัส', multiple: false, directory: false, filters: [{ name: 'MFA encrypted backup', extensions: ['mfa-backup'] }] });
      if (typeof path === 'string' && token === generation.current) { setImportPath(path); setImportPassword(''); setReplaceConfirmed(false); setOverlay('import'); }
    } catch (e) { if (token === generation.current) setError(safeError(e)); }
  }

  async function importBackup(e: FormEvent) {
    e.preventDefault(); if (status?.exists && !replaceConfirmed) return;
    const token = generation.current; setBusy(true); setError('');
    try {
      const result = await api.importBackup(importPath, importPassword);
      if (token !== generation.current) return;
      setImportPassword(''); setPassword(''); setConfirmation(''); setOverlay(null); setImportPath('');
      revision.current += 1; setAccounts(result); lastActivity.current = Date.now(); setStatus({ exists: true, unlocked: true });
      notify('นำเข้าไฟล์สำรองแล้ว ใช้รหัสผ่านของไฟล์สำรองเพื่อปลดล็อกครั้งถัดไป');
    } catch (e) { if (token === generation.current) { setError(safeError(e)); setImportPassword(''); } }
    finally { if (token === generation.current) setBusy(false); }
  }

  const token = generation.current;
  const query = search.trim().toLocaleLowerCase();
  const filtered = accounts.filter((account) => `${account.issuer} ${account.account}`.toLocaleLowerCase().includes(query));
  async function persistOrder(next: AccountCode[]) {
    if (!desktop || savingOrder.current || next === accounts) return;
    const session = generation.current;
    savingOrder.current = true; setMoving(true); revision.current += 1;
    setAccounts(next); setError('');
    try {
      const result = await api.reorder(next.map((account) => account.id));
      if (session === generation.current) { setAccounts(result); notify('บันทึกลำดับบัญชีแล้ว'); }
    } catch (error) {
      if (session !== generation.current) return;
      setError(safeError(error));
      try { const latest = await api.codes(); if (session === generation.current) setAccounts(latest); }
      catch { if (session === generation.current) await lock('คลังบัญชีถูกล็อก กรุณาปลดล็อกอีกครั้ง'); }
    } finally {
      if (session === generation.current) { savingOrder.current = false; setMoving(false); }
    }
  }
  const cardDrag = useCardDrag(!status?.unlocked || moving || !!overlay || !!deleting || !!exporting || !desktop, (id, target) => {
    void persistOrder(moveAccount(accounts, filtered.map((account) => account.id), id, target));
  });
  const importDialog = overlay === 'import' && <Modal title="นำเข้าข้อมูลสำรอง" busy={busy} onClose={() => { setOverlay(null); setImportPassword(''); setError(''); }}>
    <p className="muted">ไฟล์สำรองเข้ารหัสด้วยรหัสผ่านหลัก ณ วันที่สำรองข้อมูล</p>
    <form onSubmit={importBackup}><label>รหัสผ่านของไฟล์สำรอง<input type="password" autoComplete="off" required value={importPassword} onChange={(e) => setImportPassword(e.target.value)} disabled={busy} /></label>
      {status?.exists && <label className="checkbox-label"><input type="checkbox" checked={replaceConfirmed} onChange={(e) => setReplaceConfirmed(e.target.checked)} disabled={busy} /><span>ยืนยันแทนที่บัญชีทั้งหมดในเครื่องด้วยข้อมูลจากไฟล์นี้ กรุณาสำรองข้อมูลเดิมก่อน</span></label>}
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => { setOverlay(null); setImportPassword(''); setError(''); }}>ยกเลิก</button><button className="primary" disabled={busy || (!!status?.exists && !replaceConfirmed)}>{busy ? 'กำลังนำเข้า…' : 'นำเข้าและปลดล็อก'}</button></footer>
    </form>
  </Modal>;

  if (!status) return <main className="loading-screen"><ShieldCheck size={40} /><h1>MFA Desktop</h1>{error ? <><p className="error" role="alert">{error}</p><button className="primary" onClick={() => setStartup((old) => old + 1)}>ลองอีกครั้ง</button></> : <p>กำลังเปิดคลังบัญชี…</p>}</main>;

  if (!status.unlocked) return <main className="auth-shell">
    <section className="auth-intro"><Brand /><div><span className="auth-symbol"><FolderKey size={68} strokeWidth={1.2} /></span><h1>รหัสของคุณ<br />อยู่ใกล้แค่เปิดแอป</h1><p>ดูรหัส 2FA ได้จากคอมพิวเตอร์<br />พร้อมใช้งานแม้ไม่มีอินเทอร์เน็ต</p></div><span className="auth-footer"><ShieldCheck size={17} />เก็บข้อมูลแบบเข้ารหัสในเครื่อง</span></section>
    <section className="auth-content"><div className="auth-card"><span className="auth-lock"><LockKeyhole size={25} /></span><h2>{status.exists ? 'ปลดล็อกบัญชีของคุณ' : 'เริ่มเก็บรหัสไว้ในเครื่อง'}</h2><p className="muted">{status.exists ? 'ใส่รหัสผ่านหลักเพื่อดูรหัส 2FA ของคุณ' : 'ตั้งรหัสผ่านหลักเพื่อปกป้องคีย์ลับทุกบัญชี'}</p>
      {status.exists && device.available && device.enabled && <div className="device-unlock-action"><button type="button" className="secondary" disabled={busy} onClick={() => void authenticateDevice()}><Fingerprint size={18} />ปลดล็อกด้วย {device.label}</button>{device.label === 'Windows Hello' && <p className="muted">ใช้ใบหน้า ลายนิ้วมือ หรือ PIN ที่ตั้งไว้ใน Windows</p>}</div>}
      <form onSubmit={authenticate}><label>รหัสผ่านหลัก<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={status.exists ? 'current-password' : 'new-password'} minLength={status.exists ? undefined : 6} maxLength={1024} required disabled={busy} autoFocus /></label>
        {!status.exists && <><label>ยืนยันรหัสผ่านหลัก<input type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" minLength={6} maxLength={1024} required disabled={busy} /></label><p className="field-help">อย่างน้อย 6 ตัว ใช้ PIN ตัวเลขหรือรหัสผ่านก็ได้ เก็บรหัสนี้ไว้ให้ดี แอปไม่มีบริการรีเซ็ตรหัสผ่าน</p></>}
        {error && overlay !== 'import' && <p className="error" role="alert">{error}</p>}
        <button className="primary auth-submit" disabled={busy}>{busy ? 'กำลังเปิดคลังบัญชี…' : status.exists ? 'ปลดล็อก' : 'สร้างคลังบัญชี'}<ChevronRight size={18} /></button>
      </form>
      {status.exists && device.label === 'Windows Hello' && !(device.enabled && device.available) && <p className="field-help hello-setup-hint">{device.available
        ? 'หากต้องการใช้ใบหน้าหรือลายนิ้วมือ ให้ปลดล็อกด้วยรหัสผ่านหลัก แล้วไปที่ ตั้งค่า → ตั้งค่า Windows Hello'
        : 'Windows Hello ยังไม่พร้อมใช้งาน ตรวจสอบ Settings → Accounts → Sign-in options ใน Windows แล้วเปิดแอปใหม่'}</p>}
      {!info.mobile && <button className="text-button import-link" onClick={() => void chooseImport()} disabled={busy}><ArrowDownToLine size={16} />นำเข้าจากไฟล์สำรอง</button>}<p className="auth-version">MFA Desktop {info.version}</p>
    </div></section>{importDialog}
  </main>;

  return <div className="app-shell">
    <aside className="sidebar"><Brand /><nav className="sidebar-nav" aria-label="เมนูหลัก">
      <button className={`nav-item ${!overlay || overlay === 'add' || overlay === 'google-done' ? 'nav-active' : ''}`} aria-label="บัญชีทั้งหมด" onClick={() => setOverlay(null)}><LayoutGrid size={18} /><span>บัญชีทั้งหมด</span><span className="nav-count">{accounts.length}</span></button>
      <button className={`nav-item ${overlay === 'backup' || overlay === 'import' ? 'nav-active' : ''}`} aria-label="สำรองข้อมูล" onClick={() => setOverlay('backup')}><Archive size={18} /><span>สำรองข้อมูล</span></button>
      <button className={`nav-item ${overlay?.startsWith('sync') ? 'nav-active' : ''}`} aria-label="ซิงค์อุปกรณ์" onClick={() => setOverlay('sync')}><Cloud size={18} /><span>ซิงค์อุปกรณ์</span>{sync.status?.configured && <i className={`sync-indicator ${sync.error ? 'waiting' : ''}`} title={sync.error ? 'รอซิงค์' : 'เชื่อมต่อซิงค์แล้ว'} />}</button>
      <button className={`nav-item ${overlay === 'settings' || overlay === 'device' || overlay === 'updates' ? 'nav-active' : ''}`} aria-label="ตั้งค่า" onClick={() => setOverlay('settings')}><Settings2 size={18} /><span>ตั้งค่า</span></button>
    </nav><div className="sidebar-bottom"><div className="local-status"><span className="status-dot" /><span>{desktop ? 'คลังบัญชีเข้ารหัสในเครื่อง' : 'ข้อมูลตัวอย่าง'}</span></div><span className="version">เวอร์ชัน {info.version}</span></div></aside>
    <div className="workspace-shell"><header className="app-topbar"><label className="search-field"><Search size={17} /><span className="visually-hidden">ค้นหาบัญชี</span><input type="search" placeholder="ค้นหาบริการหรือชื่อบัญชี…" value={search} onChange={(e) => setSearch(e.target.value)} /></label><div className="topbar-actions"><button className="primary add-account-button" disabled={moving} onClick={() => setOverlay('add')}><Plus size={18} /><span>เพิ่ม / นำเข้าบัญชี</span></button><button className="icon-button" aria-label={appearance.dark ? 'ใช้โหมดสว่าง' : 'ใช้โหมดมืด'} title={appearance.dark ? 'ใช้โหมดสว่าง' : 'ใช้โหมดมืด'} onClick={appearance.toggle}>{appearance.dark ? <Sun size={18} /> : <Moon size={18} />}</button><button className="icon-button lock-button" aria-label="ล็อกแอป" title="ล็อกแอป" onClick={() => void lock()} disabled={!desktop}><LockKeyhole size={18} /></button></div></header>
    <main className="workspace"><header className="workspace-header"><div><h1>รหัส 2FA ของคุณ</h1><p className="muted">{query ? `${filtered.length} จาก ${accounts.length} บัญชี` : `${accounts.length} บัญชี · พร้อมใช้รหัสยืนยัน`}</p></div></header>
      {!desktop && <div className="preview-banner"><span>ตัวอย่างหน้าจอ</span>รหัสและบัญชีสมมติ · เพิ่มบัญชีจริงได้ในแอปที่ติดตั้งเท่านั้น</div>}
      {error && !deleting && overlay !== 'import' && <div className="error workspace-error" role="alert">{error}<button className="text-button" onClick={() => setError('')}>ปิด</button></div>}
      <div className="account-list-help"><span>คลิกการ์ดเพื่อคัดลอกรหัส</span><span id="reorder-help"><GripVertical size={15} />ลากจุดจับเพื่อเรียงบัญชี <span className="visually-hidden">หรือโฟกัสจุดจับแล้วใช้ลูกศรเพื่อย้าย Home เพื่อย้ายบนสุด End เพื่อย้ายท้ายสุด</span></span></div><section className="account-grid" data-card-size={appearance.cardSize} aria-label="บัญชี 2FA" aria-busy={moving}>
        {filtered.length ? filtered.map((account) => <AccountRow key={account.id} account={account} preview={!desktop} copied={copied === account.id} onCopy={() => void copy(account)} onDelete={() => setDeleting(account)} onExport={() => setExporting(account)} moving={moving} dragging={cardDrag.drag?.id === account.id} dropTarget={cardDrag.drag?.over === account.id && cardDrag.drag.id !== account.id} onDragStart={(event) => cardDrag.start(account.id, event)} onMoveTop={() => void persistOrder(moveAccount(accounts, accounts.map((item) => item.id), account.id, accounts[0].id))} onReorderKey={(event) => {
          const index = filtered.findIndex((item) => item.id === account.id);
          const destination = event.key === 'Home' ? 0 : event.key === 'End' ? filtered.length - 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? index - 1 : ['ArrowDown', 'ArrowRight'].includes(event.key) ? index + 1 : -1;
          if (!['Home', 'End', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          if (destination >= 0 && destination < filtered.length) void persistOrder(moveAccount(accounts, filtered.map((item) => item.id), account.id, filtered[destination].id));
        }} />) : <div className="empty-state"><KeyRound size={40} strokeWidth={1.4} /><h2>{query ? 'ไม่พบบัญชีที่ค้นหา' : 'เพิ่มบัญชีแรกของคุณ'}</h2><p>{query ? 'ลองค้นหาด้วยชื่อบริการหรืออีเมลอื่น' : 'สแกน QR ด้วยกล้อง เลือกรูป หรือกรอกคีย์ลับจากบริการ'}</p>{!query && <button className="primary" onClick={() => setOverlay('add')}><Plus size={18} />เพิ่ม / นำเข้าบัญชี</button>}</div>}
      </section>
      <footer className="workspace-footer"><span><WifiOff size={15} />สร้างรหัสได้แบบออฟไลน์</span><span>เวลาในเครื่องต้องตรง เพื่อให้รหัสใช้งานได้</span></footer>
      {notice && <div className="toast" role="status"><Check size={18} />{notice}</div>}
    </main></div>
    {overlay === 'settings' && <Settings appearance={appearance.appearance} onAppearance={appearance.setAppearance} cardSize={appearance.cardSize} onCardSize={appearance.setCardSize} info={info} device={device} native={desktop} updateHint={updateHint} onClose={() => setOverlay(null)} onDevice={() => setOverlay('device')} onUpdates={() => setOverlay('updates')} />}
    {overlay === 'backup' && <Backup enabled={desktop && !info.mobile} busy={busy} onClose={() => setOverlay(null)} onExport={() => void exportBackup()} onImport={() => void chooseImport()} />}
    {overlay === 'add' && <AddAccount onClose={() => setOverlay(null)} onSaved={(result, count) => { if (token === generation.current) { revision.current += 1; setAccounts(result); setSearch(''); setGoogleImportedCount(count ?? 0); setOverlay(count ? 'google-done' : null); notify(count ? `นำเข้าแล้ว ${count} บัญชี` : 'เพิ่มบัญชีแล้ว'); void sync.refresh(); } }} />}
    {overlay === 'google-done' && <GoogleImportResult count={googleImportedCount} status={sync.status} working={sync.working} syncError={sync.error} onClose={() => { setGoogleImportedCount(0); setOverlay(null); }} onSync={() => { setGoogleImportedCount(0); setOverlay(sync.status?.configured ? 'sync' : 'sync-create'); }} />}
    {overlay === 'updates' && <Updates configured={desktop && info.updaterConfigured} automatic onClose={() => setOverlay(null)} />}
    {overlay === 'device' && <DeviceUnlock status={device} onClose={() => setOverlay(null)} onChanged={(value) => { if (token === generation.current) { setDevice(value); setOverlay(null); notify(value.enabled ? `เปิดใช้ ${value.label} สำหรับเครื่องนี้แล้ว` : 'ปิดการปลดล็อกด้วยอุปกรณ์แล้ว'); } }} />}
    {(overlay === 'sync' || overlay === 'sync-create') && <Sync initialMode={overlay === 'sync-create' ? 'create' : 'pair'} mobile={info.mobile} status={sync.status} working={sync.working} syncError={sync.error} refresh={sync.refresh} onClose={() => setOverlay(null)} onChanged={(result) => { if (token !== generation.current) return; if (result) { revision.current += 1; setAccounts(result); } void sync.refresh(); }} />}
    {importDialog}
    {exporting && <ExportAccount key={exporting.id} account={exporting} onClose={() => setExporting(null)} />}
    {deleting && <Modal title="ลบบัญชีออกจากแอป" onClose={() => { setDeleting(null); setError(''); }} busy={busy}><p>ลบบัญชี <strong>{deleting.issuer} {deleting.account}</strong> ออกจากคลัง?</p><p className="muted">{sync.status?.configured && 'การลบจะซิงค์ไปยังอุปกรณ์ที่จับคู่ไว้ด้วย '}การลบนี้ไม่ได้ปิด 2FA ของบริการ กรุณาตรวจว่าคุณยังมีวิธีเข้าสู่ระบบหรือไฟล์สำรอง</p>{error && <p className="error" role="alert">{error}</p>}<footer className="modal-actions"><button className="secondary" onClick={() => setDeleting(null)} disabled={busy}>ยกเลิก</button><button className="danger" onClick={() => void remove()} disabled={busy}>{busy ? 'กำลังลบ…' : 'ยืนยันลบบัญชี'}</button></footer></Modal>}
  </div>;
}

function Brand() { return <div className="brand"><span className="brand-icon"><ShieldCheck size={23} strokeWidth={1.8} /></span><span>MFA<span className="brand-desktop">Desktop</span></span></div>; }
