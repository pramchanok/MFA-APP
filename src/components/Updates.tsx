import { useCallback, useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Download, RefreshCw } from 'lucide-react';
import { api, safeError } from '../api';
import { Modal } from './Modal';

export function useUpdates(configured: boolean) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [state, setState] = useState<'idle' | 'checking' | 'current' | 'available' | 'installing' | 'error'>('idle');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const started = useRef(false);
  const working = useRef(false);
  const resource = useRef<Update | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      void resource.current?.close().catch(() => {});
      resource.current = null;
    };
  }, []);
  const checkNow = useCallback(async () => {
    if (!configured || working.current) return;
    working.current = true;
    setState('checking'); setError(''); setUpdate(null);
    try {
      const previous = resource.current;
      resource.current = null;
      await previous?.close().catch(() => {});
      const result = await check({ timeout: 15_000 });
      if (!alive.current) { await result?.close(); return; }
      resource.current = result; setUpdate(result); setState(result ? 'available' : 'current');
    } catch (e) { if (alive.current) { setError(safeError(e)); setState('error'); } }
    finally { working.current = false; }
  }, [configured]);
  useEffect(() => {
    if (!configured || started.current) return;
    started.current = true;
    void checkNow();
  }, [configured, checkNow]);
  async function install() {
    if (!update || !configured || working.current) return;
    working.current = true;
    setState('installing'); setProgress(0); setError('');
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        if (event.event === 'Progress') downloaded += event.data.chunkLength;
        if (alive.current) setProgress(total ? Math.round(downloaded / total * 100) : 0);
      });
      // Windows exits inside the installer and uses the native updater exit hook.
      // Other platforms finish here; clear the session/clipboard before relaunch.
      await api.lock();
      await relaunch();
    } catch (e) { if (alive.current) { setError(safeError(e)); setState('error'); } }
    finally { working.current = false; }
  }
  return { configured, update, state, error, progress, checkNow, install };
}

export function Updates({ updater, onClose }: { updater: ReturnType<typeof useUpdates>; onClose: () => void }) {
  const { configured, update, state, error, progress, checkNow, install } = updater;
  return <Modal title="อัปเดตแอป" onClose={onClose} busy={state === 'installing' || state === 'checking'}>
    {!configured ? <div className="update-message"><RefreshCw size={32} /><h3>ยังไม่ได้เปิดระบบอัปเดต</h3><p className="muted">หากมีรุ่นที่เปิดระบบอัปเดต ให้ดาวน์โหลดและติดตั้งรุ่นนั้นด้วยตัวเองหนึ่งครั้ง จากนั้นจึงตรวจและติดตั้งอัปเดตจากในแอปได้</p></div> : <>
      <div className="update-message"><RefreshCw size={32} /><h3>{state === 'checking' ? 'กำลังตรวจสอบ…' : state === 'current' ? 'คุณใช้เวอร์ชันล่าสุดแล้ว' : update ? `มีเวอร์ชัน ${update.version}` : 'ตรวจสอบเวอร์ชันใหม่'}</h3>
        {update?.body && <p className="release-notes">{update.body}</p>}
        {state === 'installing' && <><progress max={100} value={progress || undefined} /><p>กำลังติดตั้ง… {progress > 0 ? `${progress}%` : ''} แอปจะเปิดใหม่เมื่อเสร็จ</p></>}
      </div>
      {error && <p role="alert" className="error">ตรวจอัปเดตหรือติดตั้งไม่สำเร็จ: {error}</p>}
      <footer className="modal-actions"><button className="secondary" disabled={state === 'checking' || state === 'installing'} onClick={() => void checkNow()}>ตรวจสอบอีกครั้ง</button>{update && <button className="primary" disabled={state === 'checking' || state === 'installing'} onClick={() => void install()}><Download size={17} />ติดตั้งและเปิดแอปใหม่</button>}</footer>
    </>}
  </Modal>;
}
